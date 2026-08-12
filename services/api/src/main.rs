use std::{env, net::SocketAddr};

mod auth;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use slide_helper_protocol::{
    ClientMessage, HealthResponse, PROTOCOL_VERSION, ReadinessResponse, ServerMessage,
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::{net::TcpListener, signal, sync::broadcast};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) database: PgPool,
    pub(crate) redis: redis::Client,
    pub(crate) google_auth: Option<auth::GoogleAuth>,
    room_tx: broadcast::Sender<ServerMessage>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let database_url = required_env("DATABASE_URL")?;
    let redis_url = required_env("REDIS_URL")?;
    let database = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    if env::args().nth(1).as_deref() == Some("migrate") {
        sqlx::migrate!("../../migrations")
            .run(&database)
            .await
            .context("database migration failed")?;
        info!("database migrations completed");
        return Ok(());
    }

    let redis = redis::Client::open(redis_url).context("invalid Redis URL")?;
    ping_redis(&redis).await.context("failed to ping Redis")?;
    let google_auth = auth::GoogleAuth::from_env()
        .await
        .context("failed to configure Google OpenID Connect")?;

    let bind_address = env::var("APP_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_owned());
    let socket_address: SocketAddr = bind_address
        .parse()
        .with_context(|| format!("invalid APP_BIND value: {bind_address}"))?;
    let (room_tx, _) = broadcast::channel(256);
    let state = AppState {
        database,
        redis,
        google_auth,
        room_tx,
    };

    let app = Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/version", get(version))
        .route("/api/ws", get(websocket))
        .merge(auth::router())
        .with_state(state)
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(tower_http::trace::DefaultMakeSpan::new().include_headers(false)),
        );

    let listener = TcpListener::bind(socket_address)
        .await
        .with_context(|| format!("failed to bind API to {socket_address}"))?;
    info!(address = %socket_address, "slide-helper API listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("API server stopped unexpectedly")?;
    Ok(())
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_owned(),
        service: "slide-helper-api".to_owned(),
        protocol_version: PROTOCOL_VERSION,
    })
}

async fn version(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "service": "slide-helper-api",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol_version": PROTOCOL_VERSION,
        "google_oauth_configured": state.google_auth.is_some(),
    }))
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let database_ready = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.database)
        .await
        .is_ok();
    let redis_ready = ping_redis(&state.redis).await.is_ok();
    let is_ready = database_ready && redis_ready;
    let response = ReadinessResponse {
        status: if is_ready { "ready" } else { "not_ready" }.to_owned(),
        database: database_ready,
        redis: redis_ready,
    };

    (
        if is_ready {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(response),
    )
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut room_rx = state.room_tx.subscribe();

    if send_json(
        &mut sender,
        &ServerMessage::Connected {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(incoming) = incoming else { break };
                match incoming {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ClientMessage>(text.as_str()) {
                            Ok(ClientMessage::Ping { request_id }) => {
                                if send_json(&mut sender, &ServerMessage::Pong { request_id }).await.is_err() {
                                    break;
                                }
                            }
                            Ok(ClientMessage::Broadcast { topic, payload }) => {
                                let _ = state.room_tx.send(ServerMessage::Broadcast { topic, payload });
                            }
                            Err(error) => {
                                warn!(%error, "invalid WebSocket client message");
                                if send_json(&mut sender, &ServerMessage::Error {
                                    code: "invalid_message".to_owned(),
                                }).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Ok(Message::Ping(payload)) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => {}
                }
            }
            event = room_rx.recv() => {
                match event {
                    Ok(event) => {
                        if send_json(&mut sender, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if send_json(&mut sender, &ServerMessage::Error {
                            code: "event_gap".to_owned(),
                        }).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn send_json(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerMessage,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server messages must serialize");
    sender.send(Message::Text(payload.into())).await
}

async fn ping_redis(client: &redis::Client) -> Result<()> {
    let mut connection = client.get_multiplexed_async_connection().await?;
    let _: String = redis::cmd("PING").query_async(&mut connection).await?;
    Ok(())
}

fn required_env(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("missing required environment variable {name}"))
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .init();
}

async fn shutdown_signal() {
    if let Err(error) = signal::ctrl_c().await {
        warn!(%error, "failed to listen for shutdown signal");
    }
}
