mod oidc;
mod sessions;
mod support;
mod vault;

use axum::{
    Router,
    routing::{delete, get, post},
};

use crate::AppState;

pub(crate) use oidc::GoogleAuth;
pub(crate) use sessions::authenticated_user_id;
pub(crate) use support::{hash_secret, random_token};

const SESSION_COOKIE: &str = "slide_helper_session";
const DEFAULT_SESSION_TTL_SECONDS: u64 = 7 * 24 * 60 * 60;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/google/start", get(oidc::start_google_auth))
        .route("/api/auth/google/callback", get(oidc::google_auth_callback))
        .route("/api/auth/logout", post(sessions::logout))
        .route("/api/auth/account", delete(sessions::delete_account))
        .route("/api/auth/me", get(sessions::me))
        .route("/api/auth/guest", post(vault::guest_login))
        .route("/api/auth/guest/export", post(vault::export_guest_vault))
        .route("/api/auth/guest/restore", post(vault::restore_guest_vault))
        .route("/api/auth/dev", post(sessions::dev_login))
}
