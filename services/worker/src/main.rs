use std::{env, net::SocketAddr, time::Duration};

use anyhow::{Context, Result};
use axum::{Json, Router, routing::get};
use slide_helper_protocol::{HealthResponse, PROTOCOL_VERSION};
use sqlx::postgres::PgPoolOptions;
use tokio::{net::TcpListener, signal, time};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let database_url = required_env("DATABASE_URL")?;
    let redis_url = required_env("REDIS_URL")?;
    let database = PgPoolOptions::new()
        .max_connections(3)
        .connect(&database_url)
        .await
        .context("worker failed to connect to PostgreSQL")?;
    let redis = redis::Client::open(redis_url).context("worker received invalid Redis URL")?;

    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let database_ready = sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&database)
                .await
                .is_ok();
            let redis_ready = match redis.get_multiplexed_async_connection().await {
                Ok(mut connection) => {
                    let result: redis::RedisResult<String> =
                        redis::cmd("PING").query_async(&mut connection).await;
                    result.is_ok()
                }
                Err(_) => false,
            };
            info!(database_ready, redis_ready, "worker dependency heartbeat");
        }
    });

    let bind_address = env::var("WORKER_BIND").unwrap_or_else(|_| "0.0.0.0:8081".to_owned());
    let socket_address: SocketAddr = bind_address
        .parse()
        .with_context(|| format!("invalid WORKER_BIND value: {bind_address}"))?;
    let app = Router::new()
        .route("/health/live", get(live))
        .layer(TraceLayer::new_for_http());
    let listener = TcpListener::bind(socket_address).await?;
    info!(address = %socket_address, "slide-helper worker health server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_owned(),
        service: "slide-helper-worker".to_owned(),
        protocol_version: PROTOCOL_VERSION,
    })
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
