import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const baseUrl = process.env.API_BASE_URL ?? "http://api:8080";
const websocketUrl = process.env.WS_URL ?? "ws://api:8080/api/ws";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://slide_helper:slide_helper_dev_only@postgres:5432/slide_helper";
const sessionId = "a5000000-0000-0000-0000-000000000001";
const ownerCookie = "slide_helper_session=ci-owner-session";
const realtimeEventId = "af000000-0000-0000-0000-000000000001";
const outboxEventId = "af100000-0000-0000-0000-000000000001";

const readiness = await fetch(`${baseUrl}/health/ready`);
assert.equal(readiness.status, 200);
assert.deepEqual(await readiness.json(), {
  status: "ready",
  database: true,
  redis: true,
});

const anonymousMe = await fetch(`${baseUrl}/api/auth/me`);
assert.equal(anonymousMe.status, 401);
assert.deepEqual(await anonymousMe.json(), { code: "authentication_required" });

const authStart = await fetch(`${baseUrl}/api/auth/google/start`, {
  redirect: "manual",
});
assert.equal(authStart.status, 503);
assert.deepEqual(await authStart.json(), { code: "auth_not_configured" });

const devLogin = await fetch(`${baseUrl}/api/auth/dev`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ display_name: "CI Presenter", locale: "zh-TW" }),
});
assert.equal(devLogin.status, 204);
assert.match(devLogin.headers.get("set-cookie"), /slide_helper_session=/);

const anonymousProjects = await fetch(`${baseUrl}/api/projects`);
assert.equal(anonymousProjects.status, 401);

const guestLogin = await fetch(`${baseUrl}/api/auth/guest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ locale: "zh-TW" }),
});
assert.equal(guestLogin.status, 201);
const guestCookie = guestLogin.headers.get("set-cookie").split(";", 1)[0];
assert.match(guestCookie, /^slide_helper_session=/);
const guestBody = await guestLogin.json();
assert.equal(guestBody.profile.account_type, "guest");
assert.match(guestBody.vault_id, /^[0-9a-f-]{36}$/);
assert.equal(guestBody.profile.vault_id, guestBody.vault_id);
assert.match(guestLogin.headers.get("set-cookie"), /Max-Age=315360000/);

const guestMe = await requestJson("/api/auth/me", { cookie: guestCookie });
assert.equal(guestMe.response.status, 200);
assert.equal(guestMe.body.account_type, "guest");
assert.equal(guestMe.body.vault_id, guestBody.vault_id);

const repeatedGuestLogin = await requestJson("/api/auth/guest", {
  method: "POST",
  cookie: guestCookie,
  body: { locale: "en" },
});
assert.equal(repeatedGuestLogin.response.status, 200);
assert.equal(repeatedGuestLogin.body.vault_id, guestBody.vault_id);

const guestProject = await requestJson("/api/projects", {
  method: "POST",
  cookie: guestCookie,
  body: { title: "Guest Vault demo", default_locale: "zh-TW" },
});
assert.equal(guestProject.response.status, 201);
const guestProjects = await requestJson("/api/projects", { cookie: guestCookie });
assert.equal(guestProjects.response.status, 200);
assert.equal(guestProjects.body.length, 1);
assert.equal(guestProjects.body[0].id, guestProject.body.id);

const anonymousVaultExport = await requestJson("/api/auth/guest/export", { method: "POST", body: {} });
assert.equal(anonymousVaultExport.response.status, 401);

const googleVaultExport = await requestJson("/api/auth/guest/export", {
  method: "POST",
  cookie: ownerCookie,
  body: {},
});
assert.equal(googleVaultExport.response.status, 403);
assert.deepEqual(googleVaultExport.body, { code: "guest_vault_required" });

const invalidVaultRestore = await requestJson("/api/auth/guest/restore", {
  method: "POST",
  body: { recovery_key: `svlt1.${"A".repeat(43)}` },
});
assert.equal(invalidVaultRestore.response.status, 401);
assert.deepEqual(invalidVaultRestore.body, { code: "guest_vault_recovery_invalid" });

const vaultExport = await requestJson("/api/auth/guest/export", {
  method: "POST",
  cookie: guestCookie,
  body: {},
});
assert.equal(vaultExport.response.status, 200);
assert.equal(vaultExport.body.kind, "slideact.guest_vault");
assert.equal(vaultExport.body.version, 1);
assert.equal(vaultExport.body.vault_id, guestBody.vault_id);
assert.match(vaultExport.body.recovery_key, /^svlt1\.[A-Za-z0-9_-]{43}$/);
const firstRecoveryKey = vaultExport.body.recovery_key;

const restoredVault = await requestJson("/api/auth/guest/restore", {
  method: "POST",
  body: { recovery_key: firstRecoveryKey },
});
assert.equal(restoredVault.response.status, 200);
const restoredCookie = restoredVault.response.headers.get("set-cookie").split(";", 1)[0];
assert.match(restoredCookie, /^slide_helper_session=/);
assert.notEqual(restoredCookie, guestCookie);
assert.equal(restoredVault.body.vault_id, guestBody.vault_id);
const restoredProjects = await requestJson("/api/projects", { cookie: restoredCookie });
assert.equal(restoredProjects.response.status, 200);
assert.equal(restoredProjects.body[0].id, guestProject.body.id);

const rotatedVault = await requestJson("/api/auth/guest/export", {
  method: "POST",
  cookie: restoredCookie,
  body: {},
});
assert.equal(rotatedVault.response.status, 200);
assert.notEqual(rotatedVault.body.recovery_key, firstRecoveryKey);
const staleRestore = await requestJson("/api/auth/guest/restore", {
  method: "POST",
  body: { recovery_key: firstRecoveryKey },
});
assert.equal(staleRestore.response.status, 401);
const rotatedRestore = await requestJson("/api/auth/guest/restore", {
  method: "POST",
  body: { recovery_key: rotatedVault.body.recovery_key },
});
assert.equal(rotatedRestore.response.status, 200);
assert.equal(rotatedRestore.body.vault_id, guestBody.vault_id);

const createdProject = await requestJson("/api/projects", {
  method: "POST",
  cookie: ownerCookie,
  body: { title: "Bilingual teaching demo", default_locale: "zh-TW" },
});
assert.equal(createdProject.response.status, 201);
assert.equal(createdProject.body.status, "draft");
assert.equal(createdProject.body.default_locale, "zh-TW");
const projectId = createdProject.body.id;

const strangerProject = await requestJson(`/api/projects/${projectId}`, {
  cookie: "slide_helper_session=ci-stranger-session",
});
assert.equal(strangerProject.response.status, 404);
assert.deepEqual(strangerProject.body, { code: "project_not_found" });

const updatedProject = await requestJson(`/api/projects/${projectId}`, {
  method: "PUT",
  cookie: ownerCookie,
  body: { title: "Interactive teaching demo", status: "active", default_locale: "en" },
});
assert.equal(updatedProject.response.status, 200);
assert.equal(updatedProject.body.title, "Interactive teaching demo");

const createdCue = await requestJson(`/api/projects/${projectId}/cues`, {
  method: "POST",
  cookie: ownerCookie,
  body: {
    name: "Check understanding",
    anchor_type: "deck_slide",
    anchor_value: "5",
    trigger_mode: "presenter_confirm",
    delay_seconds: 0,
  },
});
assert.equal(createdCue.response.status, 201);
assert.equal(createdCue.body.position, 0);
const cueId = createdCue.body.id;

const invalidInteraction = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}/interactions`,
  {
    method: "POST",
    cookie: ownerCookie,
    body: {
      interaction_type: "single_choice",
      prompt: "Pick one",
      options: [{ label: "Only one", is_correct: true }],
    },
  },
);
assert.equal(invalidInteraction.response.status, 400);
assert.deepEqual(invalidInteraction.body, { code: "interaction_options_invalid" });

const createdInteraction = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}/interactions`,
  {
    method: "POST",
    cookie: ownerCookie,
    body: {
      interaction_type: "single_choice",
      prompt: "Which explanation is clearest?",
      description: "Choose one answer",
      settings: {
        schema_version: 1,
        results: { audience_visibility: "after_reveal" },
      },
      options: [
        { label: "Example A", is_correct: true },
        { label: "Example B", is_correct: false },
      ],
    },
  },
);
assert.equal(createdInteraction.response.status, 201);
assert.equal(createdInteraction.body.options.length, 2);

const createdUnderstanding = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}/interactions`,
  {
    method: "POST",
    cookie: ownerCookie,
    body: {
      interaction_type: "understanding",
      prompt: "Do you understand this page?",
      description: "Tap once to update your feedback",
      settings: {
        schema_version: 1,
        results: { audience_visibility: "live" },
      },
      options: [],
    },
  },
);
assert.equal(createdUnderstanding.response.status, 201);

const createdWordCloud = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}/interactions`,
  {
    method: "POST",
    cookie: ownerCookie,
    body: {
      interaction_type: "word_cloud",
      prompt: "What is the key word you take away?",
      description: "Share one short thought",
      settings: {
        schema_version: 1,
        results: { audience_visibility: "live" },
      },
      options: [],
    },
  },
);
assert.equal(createdWordCloud.response.status, 201);

const createdQa = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}/interactions`,
  {
    method: "POST",
    cookie: ownerCookie,
    body: {
      interaction_type: "qa",
      prompt: "What would you like the presenter to clarify?",
      description: "Ask and upvote audience questions",
      settings: {
        schema_version: 1,
        results: { audience_visibility: "live" },
      },
      options: [],
    },
  },
);
assert.equal(createdQa.response.status, 201);

const cues = await requestJson(`/api/projects/${projectId}/cues`, {
  cookie: ownerCookie,
});
assert.equal(cues.response.status, 200);
assert.equal(cues.body.length, 1);
assert.equal(cues.body[0].interactions[0].prompt, "Which explanation is clearest?");

const reorderCue = await requestJson(`/api/projects/${projectId}/cues`, {
  method: "POST",
  cookie: ownerCookie,
  body: {
    name: "Temporary reorder cue",
    anchor_type: "manual",
    anchor_value: null,
    trigger_mode: "presenter_confirm",
    delay_seconds: 0,
  },
});
assert.equal(reorderCue.response.status, 201);
const invalidCueOrder = await requestJson(`/api/projects/${projectId}/cues/reorder`, {
  method: "PUT",
  cookie: ownerCookie,
  body: { cue_ids: [cueId] },
});
assert.equal(invalidCueOrder.response.status, 400);
assert.deepEqual(invalidCueOrder.body, { code: "cue_order_invalid" });
const reorderedCues = await requestJson(`/api/projects/${projectId}/cues/reorder`, {
  method: "PUT",
  cookie: ownerCookie,
  body: { cue_ids: [reorderCue.body.id, cueId] },
});
assert.equal(reorderedCues.response.status, 200);
assert.equal(reorderedCues.body[0].id, reorderCue.body.id);
assert.equal(reorderedCues.body[0].position, 0);
assert.equal(reorderedCues.body[1].id, cueId);
const restoredCues = await requestJson(`/api/projects/${projectId}/cues/reorder`, {
  method: "PUT",
  cookie: ownerCookie,
  body: { cue_ids: [cueId, reorderCue.body.id] },
});
assert.equal(restoredCues.response.status, 200);
const deletedReorderCue = await requestJson(
  `/api/projects/${projectId}/cues/${reorderCue.body.id}`,
  { method: "DELETE", cookie: ownerCookie },
);
assert.equal(deletedReorderCue.response.status, 204);

const duplicatedProject = await requestJson(`/api/projects/${projectId}/duplicate`, {
  method: "POST",
  cookie: ownerCookie,
  body: { title: "API smoke project copy" },
});
assert.equal(duplicatedProject.response.status, 201);
assert.notEqual(duplicatedProject.body.id, projectId);
assert.equal(duplicatedProject.body.title, "API smoke project copy");
assert.equal(duplicatedProject.body.status, "draft");
const duplicatedCues = await requestJson(
  `/api/projects/${duplicatedProject.body.id}/cues`,
  { cookie: ownerCookie },
);
assert.equal(duplicatedCues.response.status, 200);
assert.equal(duplicatedCues.body.length, 1);
assert.equal(duplicatedCues.body[0].interactions.length, 4);
assert.equal(duplicatedCues.body[0].interactions[0].options.length, 2);
assert.equal(
  duplicatedCues.body[0].interactions[0].settings.results.audience_visibility,
  "after_reveal",
);
const archivedDuplicate = await requestJson(
  `/api/projects/${duplicatedProject.body.id}/archive`,
  { method: "POST", cookie: ownerCookie },
);
assert.equal(archivedDuplicate.response.status, 204);
const projectsAfterArchive = await requestJson("/api/projects", { cookie: ownerCookie });
assert.equal(projectsAfterArchive.response.status, 200);
assert.equal(
  projectsAfterArchive.body.find((item) => item.id === duplicatedProject.body.id).status,
  "archived",
);

const disposableProject = await requestJson("/api/projects", {
  method: "POST",
  cookie: ownerCookie,
  body: { title: "API smoke disposable project", default_locale: "en" },
});
assert.equal(disposableProject.response.status, 201);
const deletedProject = await requestJson(`/api/projects/${disposableProject.body.id}`, {
  method: "DELETE",
  cookie: ownerCookie,
});
assert.equal(deletedProject.response.status, 204);
const missingDeletedProject = await requestJson(`/api/projects/${disposableProject.body.id}`, {
  cookie: ownerCookie,
});
assert.equal(missingDeletedProject.response.status, 404);

const createdSession = await requestJson(`/api/projects/${projectId}/sessions`, {
  method: "POST",
  cookie: ownerCookie,
  body: { locale: "zh-TW" },
});
assert.equal(createdSession.response.status, 201);
assert.equal(createdSession.body.status, "draft");
assert.equal(createdSession.body.sync_mode, "manual");
assert.equal(createdSession.body.interface_theme, "lively");

const protectedProjectDelete = await requestJson(`/api/projects/${projectId}`, {
  method: "DELETE",
  cookie: ownerCookie,
});
assert.equal(protectedProjectDelete.response.status, 409);
assert.deepEqual(protectedProjectDelete.body, { code: "project_has_history" });

const loadedSession = await requestJson(`/api/sessions/${createdSession.body.id}`, {
  cookie: ownerCookie,
});
assert.equal(loadedSession.response.status, 200);
assert.equal(loadedSession.body.project_id, projectId);

const commandSessionId = createdSession.body.id;
const openedLobby = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:open-lobby-001",
  expected_version: 0,
  command: { type: "open_lobby" },
});
assert.equal(openedLobby.response.status, 200);
assert.equal(openedLobby.body.idempotent, false);
assert.equal(openedLobby.body.snapshot.status, "lobby");
assert.match(openedLobby.body.snapshot.join_code, /^\d{6}$/);
assert.equal(openedLobby.body.snapshot.state_version, 1);
assert.equal(openedLobby.body.snapshot.interface_theme, "lively");

const replayedLobby = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:open-lobby-001",
  expected_version: 0,
  command: { type: "open_lobby" },
});
assert.equal(replayedLobby.response.status, 200);
assert.equal(replayedLobby.body.idempotent, true);
assert.equal(replayedLobby.body.snapshot.state_version, 1);

const reusedKey = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:open-lobby-001",
  expected_version: 0,
  command: { type: "start" },
});
assert.equal(reusedKey.response.status, 409);
assert.deepEqual(reusedKey.body, { code: "idempotency_key_reused" });

const staleStart = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:stale-start-001",
  expected_version: 0,
  command: { type: "start" },
});
assert.equal(staleStart.response.status, 409);
assert.deepEqual(staleStart.body, { code: "state_version_conflict" });

const startedSession = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:start-session-001",
  expected_version: 1,
  command: { type: "start" },
});
assert.equal(startedSession.response.status, 200);
assert.equal(startedSession.body.snapshot.status, "live");
assert.equal(startedSession.body.snapshot.state_version, 2);

const preparedCue = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:prepare-cue-001",
  expected_version: 2,
  command: { type: "prepare_cue", cue_id: cueId },
});
assert.equal(preparedCue.response.status, 200);
assert.equal(preparedCue.body.snapshot.current_cue_run.state, "ready");
assert.equal(preparedCue.body.snapshot.current_cue_run.interactions.length, 4);
assert.equal(preparedCue.body.snapshot.current_cue_run.interactions[0].options.length, 2);

const protectedCueDelete = await requestJson(
  `/api/projects/${projectId}/cues/${cueId}`,
  { method: "DELETE", cookie: ownerCookie },
);
assert.equal(protectedCueDelete.response.status, 409);
assert.deepEqual(protectedCueDelete.body, { code: "cue_has_history" });

const openedCue = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:open-cue-001",
  expected_version: 3,
  command: { type: "open_cue" },
});
assert.equal(openedCue.response.status, 200);
assert.equal(openedCue.body.snapshot.current_cue_run.state, "open");
assert.equal(openedCue.body.snapshot.state_version, 4);

const authoritativeSnapshot = await requestJson(
  `/api/sessions/${commandSessionId}/snapshot`,
  { cookie: ownerCookie },
);
assert.equal(authoritativeSnapshot.response.status, 200);
assert.equal(authoritativeSnapshot.body.current_cue_run.state, "open");
assert.equal(authoritativeSnapshot.body.state_version, 4);

const extensionPairing = await requestJson(
  `/api/sessions/${commandSessionId}/extension-pairing`,
  { method: "POST", cookie: ownerCookie, body: {} },
);
assert.equal(extensionPairing.response.status, 201);
assert.match(extensionPairing.body.code, /^[A-Z2-9]{8}$/);

const pairedExtension = await requestJson("/api/extension/pair", {
  method: "POST",
  body: { code: extensionPairing.body.code.toLowerCase(), device_id: "ci-extension" },
});
assert.equal(pairedExtension.response.status, 200);
assert.equal(pairedExtension.body.session_id, commandSessionId);
assert.match(pairedExtension.body.token, /^[A-Za-z0-9_-]{43}$/);
assert.match(pairedExtension.body.overlay_token, /^[A-Za-z0-9_-]{43}$/);

const controllerIssue = await requestJson(
  `/api/sessions/${commandSessionId}/tokens`,
  { method: "POST", cookie: ownerCookie, body: { role: "controller" } },
);
assert.equal(controllerIssue.response.status, 201);
assert.equal(controllerIssue.body.role, "controller");

const controllerSnapshot = await requestJson(
  `/api/sessions/${commandSessionId}/snapshot`,
  { token: controllerIssue.body.token },
);
assert.equal(controllerSnapshot.response.status, 200);
assert.equal(controllerSnapshot.body.session_id, commandSessionId);

const controllerCues = await requestJson(
  `/api/sessions/${commandSessionId}/controller-cues`,
  { token: controllerIssue.body.token },
);
assert.equal(controllerCues.response.status, 200);
assert.equal(controllerCues.body[0].id, cueId);

const overlayCannotControl = await requestJson(
  `/api/sessions/${commandSessionId}/snapshot`,
  { token: pairedExtension.body.overlay_token },
);
assert.equal(overlayCannotControl.response.status, 403);
assert.deepEqual(overlayCannotControl.body, { code: "controller_token_required" });

const queuedNavigation = await requestJson(
  `/api/sessions/${commandSessionId}/navigation`,
  { method: "POST", token: controllerIssue.body.token, body: { direction: "next" } },
);
assert.equal(queuedNavigation.response.status, 200);
assert.equal(queuedNavigation.body.accepted, true);
const rejectedNavigation = await requestJson(
  `/api/sessions/${commandSessionId}/navigation`,
  { method: "POST", token: controllerIssue.body.token, body: { direction: "sideways" } },
);
assert.equal(rejectedNavigation.response.status, 400);
assert.deepEqual(rejectedNavigation.body, { code: "navigation_direction_invalid" });
const takenNavigation = await requestJson("/api/extension/navigation", {
  token: pairedExtension.body.token,
});
assert.equal(takenNavigation.response.status, 200);
assert.equal(takenNavigation.body.command.id, queuedNavigation.body.command_id);
assert.equal(takenNavigation.body.command.direction, "next");
const consumedNavigation = await requestJson("/api/extension/navigation", {
  token: pairedExtension.body.token,
});
assert.equal(consumedNavigation.response.status, 200);
assert.equal(consumedNavigation.body.command, null);

const reusedPairing = await requestJson("/api/extension/pair", {
  method: "POST",
  body: { code: extensionPairing.body.code, device_id: "second-extension" },
});
assert.equal(reusedPairing.response.status, 200);
assert.equal(reusedPairing.body.session_id, commandSessionId);

const followedPosition = await requestJson("/api/extension/position", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "ci-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    detected_at: Date.now(),
  },
});
assert.equal(followedPosition.response.status, 200);
assert.equal(followedPosition.body.matched, true);
assert.equal(followedPosition.body.cue_id, cueId);
assert.equal(followedPosition.body.snapshot.sync_mode, "auto_connected");

const wrongDeckPosition = await requestJson("/api/extension/position", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "another-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    detected_at: Date.now() + 1,
  },
});
assert.equal(wrongDeckPosition.response.status, 409);
assert.deepEqual(wrongDeckPosition.body, { code: "deck_not_paired" });

const extensionHeartbeat = await requestJson("/api/extension/heartbeat", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "ci-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    last_error: null,
  },
});
assert.equal(extensionHeartbeat.response.status, 200);
assert.equal(extensionHeartbeat.body.connected, true);

const extensionStatus = await requestJson(
  `/api/sessions/${commandSessionId}/extension-status`,
  { cookie: ownerCookie },
);
assert.equal(extensionStatus.response.status, 200);
assert.equal(extensionStatus.body.paired, true);
assert.equal(extensionStatus.body.connected, true);
assert.equal(extensionStatus.body.device_id, "ci-extension");
assert.equal(extensionStatus.body.deck_id, "ci-google-deck");
assert.equal(extensionStatus.body.slide_index, 4);

const manualSync = await requestJson(
  `/api/sessions/${commandSessionId}/sync-mode`,
  { method: "PUT", cookie: ownerCookie, body: { mode: "manual" } },
);
assert.equal(manualSync.response.status, 200);
assert.equal(manualSync.body.sync_mode, "manual");

const ignoredManualPosition = await requestJson("/api/extension/position", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "ci-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    detected_at: Date.now() + 2,
  },
});
assert.equal(ignoredManualPosition.response.status, 200);
assert.equal(ignoredManualPosition.body.matched, false);
assert.equal(ignoredManualPosition.body.snapshot.sync_mode, "manual");

const markedDisconnected = await requestJson(
  `/api/sessions/${commandSessionId}/sync-mode`,
  { method: "PUT", cookie: ownerCookie, body: { mode: "disconnected" } },
);
assert.equal(markedDisconnected.response.status, 200);
assert.equal(markedDisconnected.body.sync_mode, "disconnected");

const recoveryHeartbeat = await requestJson("/api/extension/heartbeat", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "ci-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    last_error: null,
  },
});
assert.equal(recoveryHeartbeat.response.status, 200);
assert.equal(recoveryHeartbeat.body.sync_mode, "resync_required");

const blockedBeforeResync = await requestJson("/api/extension/position", {
  method: "POST",
  token: pairedExtension.body.token,
  body: {
    device_id: "ci-extension",
    deck_id: "ci-google-deck",
    slide_id: "slide-five",
    slide_index: 4,
    detected_at: Date.now() + 3,
  },
});
assert.equal(blockedBeforeResync.response.status, 409);
assert.deepEqual(blockedBeforeResync.body, { code: "sync_resync_required" });

const confirmedResync = await requestJson(
  `/api/sessions/${commandSessionId}/sync-mode`,
  { method: "PUT", cookie: ownerCookie, body: { mode: "auto_connected" } },
);
assert.equal(confirmedResync.response.status, 200);
assert.equal(confirmedResync.body.sync_mode, "auto_connected");

const updatedInterfaceTheme = await requestJson(
  `/api/sessions/${commandSessionId}/interface-theme`,
  { method: "PUT", cookie: ownerCookie, body: { theme: "terminal" } },
);
assert.equal(updatedInterfaceTheme.response.status, 200);
assert.equal(updatedInterfaceTheme.body.interface_theme, "terminal");

const invalidInterfaceTheme = await requestJson(
  `/api/sessions/${commandSessionId}/interface-theme`,
  { method: "PUT", cookie: ownerCookie, body: { theme: "unknown" } },
);
assert.equal(invalidInterfaceTheme.response.status, 400);
assert.deepEqual(invalidInterfaceTheme.body, { code: "interface_theme_invalid" });

const reportedClientError = await fetch(`${baseUrl}/api/diagnostics/client-errors`, {
  method: "POST",
  headers: { cookie: ownerCookie, "content-type": "application/json" },
  body: JSON.stringify({
    surface: "web",
    route: "/presenter",
    message: "Smoke test client error",
    context: {},
  }),
});
assert.equal(reportedClientError.status, 204);
const clientErrors = await requestJson("/api/diagnostics/client-errors", {
  cookie: ownerCookie,
});
assert.equal(clientErrors.response.status, 200);
assert.equal(clientErrors.body[0].message, "Smoke test client error");
const strangerErrors = await requestJson("/api/diagnostics/client-errors", {
  cookie: "slide_helper_session=ci-stranger-session",
});
assert.equal(strangerErrors.response.status, 200);
assert.equal(strangerErrors.body.length, 0);

const missingGrandfatheredJoin = await requestJson("/api/audience/join", {
  method: "POST",
  body: { join_code: "ABC23D", locale: "en", participant_key: null },
});
assert.equal(missingGrandfatheredJoin.response.status, 404);
assert.deepEqual(missingGrandfatheredJoin.body, { code: "join_code_not_found" });

const invalidJoin = await requestJson("/api/audience/join", {
  method: "POST",
  body: { join_code: "AB-23D", locale: "en", participant_key: null },
});
assert.equal(invalidJoin.response.status, 400);
assert.deepEqual(invalidJoin.body, { code: "join_code_invalid" });

const joinedAudience = await requestJson("/api/audience/join", {
  method: "POST",
  body: {
    join_code: openedLobby.body.snapshot.join_code,
    locale: "zh-TW",
    participant_key: null,
  },
});
assert.equal(joinedAudience.response.status, 201);
assert.equal(joinedAudience.body.session_id, commandSessionId);
assert.match(joinedAudience.body.participant_key, /^[A-Za-z0-9_-]{43}$/);
assert.match(joinedAudience.body.token, /^[A-Za-z0-9_-]{43}$/);
assert.equal(joinedAudience.body.topic, `session:${commandSessionId}:audience`);
assert.equal(joinedAudience.body.snapshot.interface_theme, "terminal");
assert.equal(joinedAudience.body.snapshot.current_cue_run.state, "open");
assert.equal(
  joinedAudience.body.snapshot.current_cue_run.interactions[0].options[0].is_correct,
  null,
);

const rejoinedAudience = await requestJson("/api/audience/join", {
  method: "POST",
  body: {
    join_code: openedLobby.body.snapshot.join_code,
    locale: "en",
    participant_key: joinedAudience.body.participant_key,
  },
});
assert.equal(rejoinedAudience.response.status, 201);
assert.equal(rejoinedAudience.body.participant_id, joinedAudience.body.participant_id);
assert.notEqual(rejoinedAudience.body.token, joinedAudience.body.token);

const joinedSocket = await connect(
  `${websocketUrl}?token=${joinedAudience.body.token}`,
);
const joinedSubscribed = waitForMessage(
  joinedSocket,
  (message) => message.type === "subscribed",
);
joinedSocket.send(
  JSON.stringify({ type: "subscribe", topic: joinedAudience.body.topic }),
);
assert.deepEqual(await joinedSubscribed, {
  type: "subscribed",
  topic: joinedAudience.body.topic,
});

const unauthenticatedResponse = await requestJson(
  `/api/audience/interactions/${createdInteraction.body.id}/responses`,
  {
    method: "POST",
    body: {
      cue_run_id: openedCue.body.snapshot.current_cue_run.id,
      idempotency_key: "smoke:choice-no-auth-001",
      payload: { option_id: createdInteraction.body.options[0].id },
    },
  },
);
assert.equal(unauthenticatedResponse.response.status, 401);

const aggregateEvent = waitForMessage(
  joinedSocket,
  (message) =>
    message.type === "event" &&
    message.event.event_type === "response.updated" &&
    message.event.event.interaction_id === createdInteraction.body.id,
  8000,
);
const firstChoice = await submitAudienceResponse(
  joinedAudience.body.token,
  createdInteraction.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:choice-answer-001",
    payload: { option_id: createdInteraction.body.options[0].id },
  },
);
assert.equal(firstChoice.response.status, 201);
assert.equal(firstChoice.body.aggregate.total_responses, 1);
assert.equal(firstChoice.body.aggregate.options[0].count, 1);
assert.equal((await aggregateEvent).event.event.aggregate, undefined);

const replayedChoice = await submitAudienceResponse(
  joinedAudience.body.token,
  createdInteraction.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:choice-answer-001",
    payload: { option_id: createdInteraction.body.options[0].id },
  },
);
assert.equal(replayedChoice.response.status, 200);
assert.equal(replayedChoice.body.idempotent, true);

const changedChoice = await submitAudienceResponse(
  joinedAudience.body.token,
  createdInteraction.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:choice-answer-002",
    payload: { option_id: createdInteraction.body.options[1].id },
  },
);
assert.equal(changedChoice.response.status, 201);
assert.equal(changedChoice.body.aggregate.total_responses, 1);
assert.equal(changedChoice.body.aggregate.options[0].count, 0);
assert.equal(changedChoice.body.aggregate.options[1].count, 1);

const understood = await submitAudienceResponse(
  rejoinedAudience.body.token,
  createdUnderstanding.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:understanding-001",
    payload: { level: "yellow" },
  },
);
assert.equal(understood.response.status, 201);
assert.equal(understood.body.aggregate.total_responses, 1);
assert.equal(understood.body.aggregate.green, 0);
assert.equal(understood.body.aggregate.yellow, 1);
assert.equal(understood.body.aggregate.red, 0);
assert.equal(understood.body.aggregate.yellow_percent, 100);

const wordCloud = await submitAudienceResponse(
  joinedAudience.body.token,
  createdWordCloud.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:word-cloud-001",
    payload: { text: "clarity" },
  },
);
assert.equal(wordCloud.response.status, 201);
assert.equal(wordCloud.body.aggregate.interaction_type, "word_cloud");
assert.equal(wordCloud.body.aggregate.total_responses, 1);
assert.equal(wordCloud.body.aggregate.entries[0].text, "clarity");

const secondWordCloud = await submitAudienceResponse(
  joinedAudience.body.token,
  createdWordCloud.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:word-cloud-002",
    payload: { text: "focus" },
  },
);
assert.equal(secondWordCloud.response.status, 201);
assert.equal(secondWordCloud.body.aggregate.total_responses, 2);
assert.deepEqual(
  secondWordCloud.body.aggregate.entries.map((entry) => entry.text).sort(),
  ["clarity", "focus"],
);

const thirdWordCloud = await submitAudienceResponse(
  joinedAudience.body.token,
  createdWordCloud.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:word-cloud-003",
    payload: { text: "clarity" },
  },
);
assert.equal(thirdWordCloud.response.status, 201);
assert.equal(thirdWordCloud.body.aggregate.total_responses, 3);
assert.equal(
  thirdWordCloud.body.aggregate.entries.find((entry) => entry.text === "clarity")?.count,
  2,
);

const audienceCannotPin = await requestJson(
  `/api/sessions/${commandSessionId}/interactions/${createdWordCloud.body.id}/word-cloud/pin`,
  {
    method: "PATCH",
    token: joinedAudience.body.token,
    body: { text: "clarity", pinned: true },
  },
);
assert.equal(audienceCannotPin.response.status, 403);

const pinnedWord = await requestJson(
  `/api/sessions/${commandSessionId}/interactions/${createdWordCloud.body.id}/word-cloud/pin`,
  {
    method: "PATCH",
    token: controllerIssue.body.token,
    body: { text: "clarity", pinned: true },
  },
);
assert.equal(pinnedWord.response.status, 200);
assert.deepEqual(pinnedWord.body.pinned, ["clarity"]);

const rejectedWordCloudLimit = await submitAudienceResponse(
  joinedAudience.body.token,
  createdWordCloud.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:word-cloud-004",
    payload: { text: "overflow" },
  },
);
assert.equal(rejectedWordCloudLimit.response.status, 409);
assert.deepEqual(rejectedWordCloudLimit.body, { code: "response_limit_reached" });

const rejectedWordCloudSpam = await submitAudienceResponse(
  joinedAudience.body.token,
  createdWordCloud.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:word-cloud-spam-001",
    payload: { text: "aaaaaaaaaaaaaaa" },
  },
);
assert.equal(rejectedWordCloudSpam.response.status, 400);
assert.deepEqual(rejectedWordCloudSpam.body, { code: "response_text_rejected" });

for (let index = 0; index < 11; index += 1) {
  const allowedUpdate = await submitAudienceResponse(
    joinedAudience.body.token,
    createdUnderstanding.body.id,
    {
      cue_run_id: openedCue.body.snapshot.current_cue_run.id,
      idempotency_key: `smoke:rate-allowed-${String(index).padStart(3, "0")}`,
      payload: { level: "green" },
    },
  );
  assert.equal(allowedUpdate.response.status, 201);
}
const rateLimitedResponse = await submitAudienceResponse(
  joinedAudience.body.token,
  createdUnderstanding.body.id,
  {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    idempotency_key: "smoke:rate-rejected-001",
    payload: { level: "red" },
  },
);
assert.equal(rateLimitedResponse.response.status, 429);
assert.deepEqual(rateLimitedResponse.body, { code: "rate_limit_exceeded" });

const rejectedQuestionSpam = await requestJson("/api/audience/questions", {
  method: "POST",
  token: joinedAudience.body.token,
  body: {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    body: "https://one.example https://two.example https://three.example",
  },
});
assert.equal(rejectedQuestionSpam.response.status, 400);
assert.deepEqual(rejectedQuestionSpam.body, { code: "question_body_rejected" });

const submittedQuestion = await requestJson("/api/audience/questions", {
  method: "POST",
  token: joinedAudience.body.token,
  body: {
    cue_run_id: openedCue.body.snapshot.current_cue_run.id,
    body: "Could you show another real-world example?",
  },
});
assert.equal(submittedQuestion.response.status, 201);
assert.equal(submittedQuestion.body.status, "visible");
assert.equal(submittedQuestion.body.votes, 0);

const votedQuestion = await requestJson(
  `/api/audience/questions/${submittedQuestion.body.id}/vote`,
  { method: "POST", token: joinedAudience.body.token },
);
assert.equal(votedQuestion.response.status, 200);
assert.deepEqual(votedQuestion.body, { voted: true, votes: 1 });

const unvotedQuestion = await requestJson(
  `/api/audience/questions/${submittedQuestion.body.id}/vote`,
  { method: "POST", token: joinedAudience.body.token },
);
assert.equal(unvotedQuestion.response.status, 200);
assert.deepEqual(unvotedQuestion.body, { voted: false, votes: 0 });

const revotedQuestion = await requestJson(
  `/api/audience/questions/${submittedQuestion.body.id}/vote`,
  { method: "POST", token: rejoinedAudience.body.token },
);
assert.equal(revotedQuestion.response.status, 200);
assert.deepEqual(revotedQuestion.body, { voted: true, votes: 1 });

const presenterQuestions = await requestJson(
  `/api/sessions/${commandSessionId}/questions`,
  { token: controllerIssue.body.token },
);
assert.equal(presenterQuestions.response.status, 200);
assert.equal(presenterQuestions.body.length, 1);
assert.equal(presenterQuestions.body[0].body, submittedQuestion.body.body);

const pinnedQuestion = await requestJson(
  `/api/sessions/${commandSessionId}/questions/${submittedQuestion.body.id}`,
  { method: "PATCH", token: controllerIssue.body.token, body: { status: "pinned" } },
);
assert.equal(pinnedQuestion.response.status, 200);
assert.equal(pinnedQuestion.body.status, "pinned");
assert.equal(pinnedQuestion.body.votes, 1);
const highlightedQuestion = await requestJson(
  `/api/sessions/${commandSessionId}/questions/${submittedQuestion.body.id}`,
  { method: "PATCH", token: controllerIssue.body.token, body: { status: "highlighted" } },
);
assert.equal(highlightedQuestion.response.status, 200);
assert.equal(highlightedQuestion.body.status, "highlighted");
const repinnedQuestion = await requestJson(
  `/api/sessions/${commandSessionId}/questions/${submittedQuestion.body.id}`,
  { method: "PATCH", token: controllerIssue.body.token, body: { status: "pinned" } },
);
assert.equal(repinnedQuestion.response.status, 200);

const anonymousLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
);
assert.equal(anonymousLiveView.response.status, 401);

const audienceLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: joinedAudience.body.token },
);
assert.equal(audienceLiveView.response.status, 200);
assert.equal(audienceLiveView.body.audience_count, 1);
assert.equal(audienceLiveView.body.aggregates.length, 2);
assert.equal(
  audienceLiveView.body.aggregates.some(
    (item) => item.interaction_id === createdInteraction.body.id,
  ),
  false,
);
assert.equal(audienceLiveView.body.questions.length, 1);
assert.equal(audienceLiveView.body.questions[0].status, "pinned");
assert.equal(audienceLiveView.body.questions[0].voted_by_me, true);
assert.equal(
  audienceLiveView.body.my_responses.some(
    (item) => item.interaction_id === createdInteraction.body.id,
  ),
  true,
);
const publicQaOverlay = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: pairedExtension.body.overlay_token },
);
assert.equal(publicQaOverlay.response.status, 200);
assert.equal(publicQaOverlay.body.questions.length, 1);
assert.equal(publicQaOverlay.body.questions[0].body, submittedQuestion.body.body);

const exportedCsv = await fetch(
  `${baseUrl}/api/sessions/${commandSessionId}/export.csv`,
  { headers: { cookie: ownerCookie } },
);
assert.equal(exportedCsv.status, 200);
assert.match(exportedCsv.headers.get("content-type"), /^text\/csv/);
assert.match(
  exportedCsv.headers.get("content-disposition"),
  new RegExp(`slideact-${commandSessionId}\\.csv`),
);
const exportedCsvBody = await exportedCsv.text();
assert.match(exportedCsvBody, /record_type,session_id,cue_name/);
assert.match(exportedCsvBody, /"response"/);
assert.match(exportedCsvBody, /"question"/);
assert.match(exportedCsvBody, /Could you show another real-world example\?/);

const forbiddenCsv = await fetch(
  `${baseUrl}/api/sessions/${commandSessionId}/export.csv`,
  { headers: { cookie: "slide_helper_session=ci-stranger-session" } },
);
assert.equal(forbiddenCsv.status, 404);
assert.equal(
  audienceLiveView.body.snapshot.current_cue_run.interactions[0].options[0].is_correct,
  null,
);

const overlayIssue = await requestJson(
  `/api/sessions/${commandSessionId}/tokens`,
  { method: "POST", cookie: ownerCookie, body: { role: "overlay" } },
);
assert.equal(overlayIssue.response.status, 201);
const overlayLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: overlayIssue.body.token },
);
assert.equal(overlayLiveView.response.status, 200);
assert.equal(overlayLiveView.body.aggregates.length, 2);
assert.equal(
  overlayLiveView.body.aggregates.some(
    (item) => item.interaction_id === createdInteraction.body.id,
  ),
  false,
);

const commandPresenterIssue = await requestJson(
  `/api/sessions/${commandSessionId}/tokens`,
  { method: "POST", cookie: ownerCookie, body: { role: "presenter" } },
);
assert.equal(commandPresenterIssue.response.status, 201);
const presenterLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: commandPresenterIssue.body.token },
);
assert.equal(presenterLiveView.response.status, 200);
assert.equal(presenterLiveView.body.aggregates.length, 3);
assert.equal(
  presenterLiveView.body.aggregates.some(
    (item) => item.interaction_id === createdInteraction.body.id,
  ),
  true,
);

const revealedDirectly = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:direct-reveal-001",
  expected_version: updatedInterfaceTheme.body.state_version,
  command: { type: "reveal_cue" },
}, controllerIssue.body.token);
assert.equal(revealedDirectly.response.status, 200);
assert.equal(revealedDirectly.body.snapshot.current_cue_run.state, "revealed");
const reopenedAfterReveal = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:reopen-after-reveal-001",
  expected_version: revealedDirectly.body.snapshot.state_version,
  command: { type: "reopen_cue" },
}, controllerIssue.body.token);
assert.equal(reopenedAfterReveal.response.status, 200);
assert.equal(reopenedAfterReveal.body.snapshot.current_cue_run.state, "open");
const revealedForAudience = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:reveal-after-reopen-001",
  expected_version: reopenedAfterReveal.body.snapshot.state_version,
  command: { type: "reveal_cue" },
});
assert.equal(revealedForAudience.response.status, 200);
const revealedAudienceLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: joinedAudience.body.token },
);
assert.equal(revealedAudienceLiveView.response.status, 200);
assert.equal(revealedAudienceLiveView.body.aggregates.length, 3);
assert.deepEqual(
  revealedAudienceLiveView.body.aggregates.find(
    (item) => item.aggregate.interaction_type === "word_cloud",
  )?.aggregate.pinned,
  ["clarity"],
);
const persistedSessionResults = await requestJson(
  `/api/sessions/${commandSessionId}/results`,
  { cookie: ownerCookie },
);
assert.equal(persistedSessionResults.response.status, 200);
assert.equal(persistedSessionResults.body.session_id, commandSessionId);
assert.equal(persistedSessionResults.body.cue_runs.length, 1);
assert.equal(persistedSessionResults.body.cue_runs[0].interactions.length, 4);
assert.equal(
  persistedSessionResults.body.cue_runs[0].interactions.some(
    (interaction) => interaction.aggregate?.total_responses === 1,
  ),
  true,
);
assert.equal(persistedSessionResults.body.cue_runs[0].questions.length, 1);
const showedJoinQr = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:show-join-qr-001",
  expected_version: revealedForAudience.body.snapshot.state_version,
  command: { type: "show_join_qr" },
}, controllerIssue.body.token);
assert.equal(showedJoinQr.response.status, 200);
assert.equal(showedJoinQr.body.snapshot.presentation_view, "join_qr");
assert.equal(
  showedJoinQr.body.snapshot.current_cue_run.id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
assert.equal(showedJoinQr.body.snapshot.current_cue_run.state, "revealed");
assert.equal(
  showedJoinQr.body.snapshot.state_version,
  revealedForAudience.body.snapshot.state_version + 1,
);
const restoredCueView = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:show-cue-after-qr-001",
  expected_version: showedJoinQr.body.snapshot.state_version,
  command: { type: "show_cue" },
}, controllerIssue.body.token);
assert.equal(restoredCueView.response.status, 200);
assert.equal(restoredCueView.body.snapshot.presentation_view, "cue");
assert.equal(
  restoredCueView.body.snapshot.current_cue_run.id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
const restoredCueLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: commandPresenterIssue.body.token },
);
assert.equal(restoredCueLiveView.response.status, 200);
assert.equal(restoredCueLiveView.body.aggregates.length, 3);
const otherSlideCue = await requestJson(`/api/projects/${projectId}/cues`, {
  method: "POST",
  cookie: ownerCookie,
  body: {
    name: "Later slide",
    anchor_type: "deck_slide",
    anchor_value: "8",
    trigger_mode: "presenter_confirm",
    delay_seconds: 0,
  },
});
assert.equal(otherSlideCue.response.status, 201);
const preparedOtherSlide = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:prepare-other-slide-001",
  expected_version: restoredCueView.body.snapshot.state_version,
  command: { type: "prepare_cue", cue_id: otherSlideCue.body.id },
});
assert.equal(preparedOtherSlide.response.status, 200);
assert.equal(preparedOtherSlide.body.snapshot.current_cue_run.cue_id, otherSlideCue.body.id);
assert.notEqual(
  preparedOtherSlide.body.snapshot.current_cue_run.id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
const restoredOriginalSlide = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:restore-original-slide-001",
  expected_version: preparedOtherSlide.body.snapshot.state_version,
  command: { type: "prepare_cue", cue_id: cueId },
});
assert.equal(restoredOriginalSlide.response.status, 200);
assert.equal(
  restoredOriginalSlide.body.snapshot.current_cue_run.id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
assert.equal(restoredOriginalSlide.body.snapshot.current_cue_run.state, "revealed");
const restoredOriginalLiveView = await requestJson(
  `/api/live/sessions/${commandSessionId}`,
  { token: commandPresenterIssue.body.token },
);
assert.equal(restoredOriginalLiveView.response.status, 200);
assert.equal(restoredOriginalLiveView.body.aggregates.length, 3);
assert.equal(
  restoredOriginalLiveView.body.aggregates.some(
    (item) => item.aggregate?.total_responses === 1,
  ),
  true,
);
const endedCommandSession = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:end-session-preserve-results-001",
  expected_version: restoredOriginalSlide.body.snapshot.state_version,
  command: { type: "end" },
});
assert.equal(endedCommandSession.response.status, 200);
assert.equal(endedCommandSession.body.snapshot.status, "ended");
const endedSnapshot = await requestJson(
  `/api/sessions/${commandSessionId}/snapshot`,
  { cookie: ownerCookie },
);
assert.equal(endedSnapshot.response.status, 200);
assert.equal(endedSnapshot.body.status, "ended");
const activeCodeReservations = execFileSync(
  "psql",
  [
    databaseUrl,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--command",
    `SELECT COUNT(*) FROM live_sessions WHERE join_code = '${openedLobby.body.snapshot.join_code}' AND status IN ('lobby', 'live', 'paused');`,
  ],
  { encoding: "utf8" },
).trim();
assert.equal(activeCodeReservations, "0");
const endedSessionResults = await requestJson(
  `/api/sessions/${commandSessionId}/results`,
  { cookie: ownerCookie },
);
assert.equal(endedSessionResults.response.status, 200);
assert.equal(endedSessionResults.body.status, "ended");
assert.equal(endedSessionResults.body.cue_runs.length, 2);
assert.equal(endedSessionResults.body.cue_runs[0].interactions.length, 4);
assert.equal(endedSessionResults.body.cue_runs[0].questions.length, 1);
assert.equal(
  endedSessionResults.body.cue_runs[1].id,
  preparedOtherSlide.body.snapshot.current_cue_run.id,
);
const reopenedEndedSession = await sendCommand(commandSessionId, {
  idempotency_key: "smoke:reopen-ended-session-001",
  expected_version: endedCommandSession.body.snapshot.state_version,
  command: { type: "reopen_session" },
});
assert.equal(reopenedEndedSession.response.status, 200);
assert.equal(reopenedEndedSession.body.snapshot.status, "lobby");
assert.equal(
  reopenedEndedSession.body.snapshot.current_cue_run.id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
assert.equal(
  reopenedEndedSession.body.snapshot.join_code,
  openedLobby.body.snapshot.join_code,
);
const reopenedSessionResults = await requestJson(
  `/api/sessions/${commandSessionId}/results`,
  { cookie: ownerCookie },
);
assert.equal(reopenedSessionResults.response.status, 200);
assert.equal(reopenedSessionResults.body.status, "lobby");
assert.equal(reopenedSessionResults.body.cue_runs.length, 2);
assert.equal(
  reopenedSessionResults.body.cue_runs[0].id,
  revealedForAudience.body.snapshot.current_cue_run.id,
);
assert.equal(
  reopenedSessionResults.body.cue_runs[0].interactions.some(
    (interaction) => interaction.aggregate?.total_responses === 1,
  ),
  true,
);
assert.equal(
  reopenedSessionResults.body.cue_runs[1].id,
  preparedOtherSlide.body.snapshot.current_cue_run.id,
);
joinedSocket.close();

const strangerIssue = await issueToken(
  "presenter",
  "slide_helper_session=ci-stranger-session",
);
assert.equal(strangerIssue.response.status, 404);
assert.deepEqual(strangerIssue.body, { code: "session_not_found" });

const presenterIssue = await issueToken("presenter", ownerCookie);
assert.equal(presenterIssue.response.status, 201);
assert.equal(presenterIssue.body.role, "presenter");
assert.equal(presenterIssue.body.session_id, sessionId);
assert.equal(presenterIssue.body.topic, `session:${sessionId}:presenter`);
assert.match(presenterIssue.body.token, /^[A-Za-z0-9_-]{43}$/);

const audienceIssue = await issueToken("audience", ownerCookie);
assert.equal(audienceIssue.response.status, 201);
assert.equal(audienceIssue.body.topic, `session:${sessionId}:audience`);

const presenter = await connect(
  `${websocketUrl}?token=${presenterIssue.body.token}`,
);
const audience = await connect(`${websocketUrl}?token=${audienceIssue.body.token}`);

const pong = waitForMessage(presenter, (message) => message.type === "pong");
presenter.send(JSON.stringify({ type: "ping", request_id: "smoke-ping" }));
assert.deepEqual(await pong, { type: "pong", request_id: "smoke-ping" });

const presenterSubscribed = waitForMessage(
  presenter,
  (message) => message.type === "subscribed",
);
presenter.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:presenter`,
  }),
);
assert.deepEqual(await presenterSubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:presenter`,
});

const forbidden = waitForMessage(
  audience,
  (message) => message.type === "error",
);
audience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:presenter`,
  }),
);
assert.deepEqual(await forbidden, {
  type: "error",
  code: "realtime_topic_forbidden",
});

const audienceSubscribed = waitForMessage(
  audience,
  (message) => message.type === "subscribed",
);
audience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:audience`,
  }),
);
assert.deepEqual(await audienceSubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:audience`,
});

const liveEvent = waitForMessage(
  audience,
  (message) =>
    message.type === "event" && message.event.event_id === realtimeEventId,
  8000,
);
enqueueAudienceCountEvent();
assertRealtimeEvent(await liveEvent);
await waitForOutboxPublished();

const replayAudience = await connect(
  `${websocketUrl}?token=${audienceIssue.body.token}`,
);
const replaySubscribed = waitForMessage(
  replayAudience,
  (message) => message.type === "subscribed",
);
const replayEvent = waitForMessage(
  replayAudience,
  (message) =>
    message.type === "event" && message.event.event_id === realtimeEventId,
);
replayAudience.send(
  JSON.stringify({
    type: "subscribe",
    topic: `session:${sessionId}:audience`,
    after_sequence: 0,
  }),
);
assert.deepEqual(await replaySubscribed, {
  type: "subscribed",
  topic: `session:${sessionId}:audience`,
});
assertRealtimeEvent(await replayEvent);
replayAudience.close();

const broadcastRejected = waitForMessage(
  presenter,
  (message) => message.type === "error",
);
presenter.send(
  JSON.stringify({
    type: "broadcast",
    topic: `session:${sessionId}:presenter`,
    payload: { slide: 5 },
  }),
);
assert.deepEqual(await broadcastRejected, {
  type: "error",
  code: "client_broadcast_forbidden",
});

const revokedSocket = waitForMessage(
  audience,
  (message) => message.type === "error" && message.code === "session_token_invalid",
  8000,
);
const revoke = await fetch(
  `${baseUrl}/api/sessions/${sessionId}/tokens/${audienceIssue.body.id}`,
  { method: "DELETE", headers: { cookie: ownerCookie } },
);
assert.equal(revoke.status, 204);
assert.deepEqual(await revokedSocket, {
  type: "error",
  code: "session_token_invalid",
});
await assert.rejects(
  connect(`${websocketUrl}?token=${audienceIssue.body.token}`),
  /WebSocket/,
);

presenter.close();
audience.close();

const raceProject = await requestJson("/api/projects", {
  method: "POST",
  cookie: ownerCookie,
  body: { title: "Command race fixture", default_locale: "en" },
});
assert.equal(raceProject.response.status, 201);
const raceSession = await requestJson(
  `/api/projects/${raceProject.body.id}/sessions`,
  { method: "POST", cookie: ownerCookie, body: { locale: "en" } },
);
assert.equal(raceSession.response.status, 201);
const raceResults = await Promise.all([
  sendCommand(raceSession.body.id, {
    idempotency_key: "smoke:race-open-lobby-a",
    expected_version: 0,
    command: { type: "open_lobby" },
  }),
  sendCommand(raceSession.body.id, {
    idempotency_key: "smoke:race-open-lobby-b",
    expected_version: 0,
    command: { type: "open_lobby" },
  }),
]);
assert.deepEqual(
  raceResults.map((result) => result.response.status).sort(),
  [200, 409],
);
assert.equal(
  raceResults.find((result) => result.response.status === 409).body.code,
  "state_version_conflict",
);

const deletionGuest = await fetch(`${baseUrl}/api/auth/guest`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ locale: "en" }),
});
assert.equal(deletionGuest.status, 201);
const deletionCookie = deletionGuest.headers.get("set-cookie").split(";", 1)[0];
const deletionProject = await requestJson("/api/projects", {
  method: "POST",
  cookie: deletionCookie,
  body: { title: "Delete me", default_locale: "en" },
});
assert.equal(deletionProject.response.status, 201);
const invalidDeletion = await requestJson("/api/auth/account", {
  method: "DELETE",
  cookie: deletionCookie,
  body: { confirmation: "delete" },
});
assert.equal(invalidDeletion.response.status, 400);
const deletedAccount = await fetch(`${baseUrl}/api/auth/account`, {
  method: "DELETE",
  headers: { cookie: deletionCookie, "content-type": "application/json" },
  body: JSON.stringify({ confirmation: "DELETE" }),
});
assert.equal(deletedAccount.status, 204);
assert.match(deletedAccount.headers.get("set-cookie"), /Max-Age=0/);
const deletedMe = await requestJson("/api/auth/me", { cookie: deletionCookie });
assert.equal(deletedMe.response.status, 401);
console.log("API and WebSocket smoke test passed");

async function issueToken(role, cookie) {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ role }),
  });
  return {
    response,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function requestJson(path, { method = "GET", cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    response,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function sendCommand(session, body, token) {
  return requestJson(`/api/sessions/${session}/commands`, {
    method: "POST",
    cookie: token ? undefined : ownerCookie,
    token,
    body,
  });
}

async function submitAudienceResponse(token, interactionId, body) {
  const response = await fetch(
    `${baseUrl}/api/audience/interactions/${interactionId}/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { response, body: await response.json() };
}

function enqueueAudienceCountEvent() {
  const sql = `
    SELECT enqueue_session_event(
      '${realtimeEventId}',
      '${outboxEventId}',
      '${sessionId}',
      1,
      1,
      'session:${sessionId}:audience',
      '{"event_type":"audience.count_updated","count":42}'::jsonb
    );
  `;
  execFileSync("psql", [
    databaseUrl,
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--quiet",
    "--command",
    sql,
  ]);
}

function assertRealtimeEvent(message) {
  assert.equal(message.type, "event");
  assert.equal(message.topic, `session:${sessionId}:audience`);
  assert.equal(message.event.schema_version, 1);
  assert.equal(message.event.event_id, realtimeEventId);
  assert.equal(message.event.session_id, sessionId);
  assert.equal(message.event.sequence, 1);
  assert.equal(message.event.state_version, 1);
  assert.equal(message.event.event_type, "audience.count_updated");
  assert.match(message.event.occurred_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(message.event.event, {
    event_type: "audience.count_updated",
    count: 42,
  });
}

async function waitForOutboxPublished() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const published = execFileSync(
      "psql",
      [
        databaseUrl,
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "--tuples-only",
        "--no-align",
        "--command",
        `SELECT published_at IS NOT NULL FROM outbox_events WHERE id = '${outboxEventId}';`,
      ],
      { encoding: "utf8" },
    ).trim();
    if (published === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("outbox event was not marked as published");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);

    socket.addEventListener("message", function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.type === "connected") {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(socket);
      }
    });
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("WebSocket error"));
      },
      { once: true },
    );
  });
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket message timeout")),
      timeoutMs,
    );

    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (predicate(message)) {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(message);
      }
    }

    socket.addEventListener("message", onMessage);
  });
}
