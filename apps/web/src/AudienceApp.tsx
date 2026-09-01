import { type FormEvent, useEffect, useState } from "react";

import { ApiError, apiJson, postJson, uuid } from "./api";
import type { Translate } from "./i18n";
import { typeName } from "./lib/interactions";
import { LIVE_POLL_INTERVAL_MS, useLiveSession } from "./lib/liveSession";
import {
  AggregateBars,
  AudienceQuestionBoard,
  QuestionList,
  questionsForInteraction,
} from "./ResultVisuals";
import type { ProjectionTheme } from "./projectionTheme";
import type { LiveView, Question, SessionSnapshot, SnapshotInteraction } from "./types";

type JoinResponse = {
  session_id: string;
  participant_id: string;
  participant_key: string;
  token: string;
  topic: string;
  expires_in_seconds: number;
  snapshot: SessionSnapshot;
};

type PendingAnswer = {
  interaction: SnapshotInteraction;
  payload: Record<string, unknown>;
  label: string;
  idempotencyKey: string;
};

export function AudienceApp({ t, locale, onThemeChange }: {
  t: Translate;
  locale: string;
  onThemeChange: (theme: ProjectionTheme) => void;
}) {
  const pathCode = decodeURIComponent(location.pathname.split("/")[2] ?? "");
  const [code, setCode] = useState(pathCode);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("slide-helper-display-name") ?? "");
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const connected = () => setOnline(true);
    const disconnected = () => setOnline(false);
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => {
      window.removeEventListener("online", connected);
      window.removeEventListener("offline", disconnected);
    };
  }, []);

  const { live, setLive, refresh } = useLiveSession({
    sessionId: joined?.session_id ?? "",
    token: joined?.token ?? "",
    topic: joined?.topic ?? "",
    pollMs: LIVE_POLL_INTERVAL_MS.audience,
    enabled: joined !== null,
    immediate: false,
    onLive: (next) => {
      if (!joined) return;
      setAnswers((current) => mergeAudienceAnswers(joined.session_id, joined.participant_id, current, next.my_responses));
    },
  });

  useEffect(() => {
    const interfaceTheme = live?.snapshot.interface_theme ?? joined?.snapshot.interface_theme;
    if (interfaceTheme) onThemeChange(interfaceTheme);
  }, [joined?.snapshot.interface_theme, live?.snapshot.interface_theme, onThemeChange]);

  async function join(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const participantKey = localStorage.getItem("slide-helper-participant-key");
      const normalizedDisplayName = displayName.trim();
      const response = await postJson<JoinResponse>("/api/audience/join", {
        join_code: code,
        locale,
        participant_key: participantKey,
        display_name: normalizedDisplayName || null,
      });
      localStorage.setItem("slide-helper-participant-key", response.participant_key);
      if (normalizedDisplayName) localStorage.setItem("slide-helper-display-name", normalizedDisplayName);
      else localStorage.removeItem("slide-helper-display-name");
      setJoined(response);
      setAnswers(readStoredAnswers(response.session_id, response.participant_id));
      setLive({ snapshot: response.snapshot, audience_count: 1, aggregates: [], questions: [], my_responses: [] });
      history.replaceState(null, "", `/join/${code}`);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === "join_code_not_found"
          ? t("audience.codeNotFound")
          : cause instanceof ApiError && cause.code === "display_name_invalid"
            ? t("audience.nicknameInvalid")
          : t("error.generic", { code: cause instanceof ApiError ? cause.code : "network_error" }),
      );
    } finally {
      setBusy(false);
    }
  }

  async function answer(
    interaction: SnapshotInteraction,
    payload: Record<string, unknown>,
    label: string,
    idempotencyKey = uuid(),
  ) {
    if (!joined || !live?.snapshot.current_cue_run) return false;
    setBusy(true);
    setError("");
    setPendingAnswer(null);
    try {
      await apiJson(`/api/audience/interactions/${interaction.id}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
        body: JSON.stringify({
          cue_run_id: live.snapshot.current_cue_run.id,
          idempotency_key: idempotencyKey,
          payload,
        }),
      });
      setAnswers((current) => {
        const next = { ...current, [interaction.id]: label };
        storeAnswers(joined.session_id, joined.participant_id, next);
        return next;
      });
      setPendingAnswer(null);
      await refresh();
      return true;
    } catch (cause) {
      setError(audienceError(t, cause, interaction));
      if (!(cause instanceof ApiError) || cause.status >= 500) {
        setPendingAnswer({ interaction, payload, label, idempotencyKey });
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitQuestion(interactionId: string, body: string) {
    if (!joined || !live?.snapshot.current_cue_run) return false;
    setBusy(true);
    setError("");
    try {
      await apiJson("/api/audience/questions", {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
        body: JSON.stringify({
          cue_run_id: live.snapshot.current_cue_run.id,
          interaction_id: interactionId,
          body,
        }),
      });
      await refresh();
      return true;
    } catch (cause) {
      setError(audienceError(t, cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function voteQuestion(questionId: string) {
    if (!joined) return;
    setBusy(true);
    setError("");
    try {
      await apiJson(`/api/audience/questions/${questionId}/vote`, {
        method: "POST",
        headers: { authorization: `Bearer ${joined.token}` },
      });
      await refresh();
    } catch (cause) {
      setError(audienceError(t, cause));
    } finally {
      setBusy(false);
    }
  }

  if (!joined) {
    return (
      <main className="audience-shell join-card">
        <p className="eyebrow">{t("audience.eyebrow")}</p>
        <h1>{t("audience.joinHeading")}</h1>
        <p>{t("audience.joinCopy")}</p>
        <form className="audience-join-form" onSubmit={join}>
          <label className="join-field">
            <span>{t("audience.codeLabel")}</span>
            <input autoFocus name="join-code" inputMode="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} pattern="[A-Za-z0-9]*" value={code} onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6))} maxLength={6} placeholder="123456" />
          </label>
          <label className="join-field">
            <span>{t("audience.nicknameLabel")}</span>
            <input
              className="nickname-input"
              name="nickname"
              autoComplete="nickname"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={40}
              placeholder={t("audience.nicknamePlaceholder")}
            />
            <small>{t("audience.nicknameHint")}</small>
          </label>
          <button className="primary-button" disabled={busy || code.length !== 6} type="submit">{t("landing.join")}</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </main>
    );
  }

  const snapshot = live?.snapshot ?? joined.snapshot;
  const cueRun = snapshot.current_cue_run;
  const stageMode = audienceStageMode(snapshot.status, cueRun?.state);
  return (
    <main className="audience-shell">
      <header className="audience-header">
        <span className={online ? "connection-state online" : "connection-state offline"}>{online ? t("audience.online") : t("audience.offline")}</span>
        <span className="audience-count">{t("audience.people", { count: live?.audience_count ?? 1 })}</span>
      </header>
      <section className="audience-stage">
        <p className="eyebrow">{snapshot.join_code} · {t(`statusName.${snapshot.status}`)}</p>
        {stageMode === "waiting" || !cueRun ? (
          <WaitingState t={t} status={snapshot.status} />
        ) : stageMode === "open" ? (
          <>
            <div className="audience-interactions">
              {cueRun.interactions.map((interaction) => (
                <AudienceInteraction
                  key={interaction.id}
                  t={t}
                  interaction={interaction}
                  answer={answers[interaction.id]}
                  sentCount={(live?.my_responses ?? []).filter((item) => item.interaction_id === interaction.id).length}
                  busy={busy}
                  submit={(payload, label) => answer(interaction, payload, label)}
                  questions={live?.questions ?? []}
                  submitQuestion={submitQuestion}
                  voteQuestion={voteQuestion}
                />
              ))}
            </div>
          </>
        ) : (
          <ResultsView t={t} live={live} state={cueRun.state} />
        )}
        {error && <div className="audience-error"><p className="form-error" role="alert">{error}</p>{pendingAnswer && <button disabled={busy} onClick={() => answer(pendingAnswer.interaction, pendingAnswer.payload, pendingAnswer.label, pendingAnswer.idempotencyKey)}>{t("audience.retry")}</button>}</div>}
      </section>
    </main>
  );
}

function audienceError(t: Translate, cause: unknown, interaction?: SnapshotInteraction) {
  if (cause instanceof ApiError && cause.status === 429) return t("audience.rateLimited");
  if (cause instanceof ApiError && ["qa_not_open", "interaction_not_open"].includes(cause.code)) return t("audience.typeSoon");
  if (cause instanceof ApiError && cause.code === "response_limit_reached") {
    return t("audience.wordCloudLimit", { max: audienceResponseSettings(interaction).submissionLimit });
  }
  if (cause instanceof ApiError && cause.code === "response_change_not_allowed") return t("audience.changeLocked");
  if (cause instanceof ApiError && cause.code === "response_duplicate_not_allowed") return t("audience.duplicateNotAllowed");
  return t("error.generic", { code: cause instanceof ApiError ? cause.code : "network_error" });
}

function WaitingState({ t, status }: { t: Translate; status: string }) {
  return (
    <div className="waiting-state">
      <span className="waiting-orbit"><i /></span>
      <h1>{status === "paused" ? t("audience.paused") : status === "ended" ? t("audience.ended") : t("audience.waiting")}</h1>
      <p>{t("audience.waitingCopy")}</p>
    </div>
  );
}

function AudienceInteraction({ t, interaction, answer, sentCount = 0, busy, submit, questions, submitQuestion, voteQuestion }: {
  t: Translate;
  interaction: SnapshotInteraction;
  answer?: string;
  sentCount?: number;
  busy: boolean;
  submit: (payload: Record<string, unknown>, label: string) => Promise<boolean>;
  questions: Question[];
  submitQuestion: (interactionId: string, body: string) => Promise<boolean>;
  voteQuestion: (questionId: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [questionBody, setQuestionBody] = useState("");
  const [questionSent, setQuestionSent] = useState(false);
  const [choiceSelection, setChoiceSelection] = useState(() => choiceIdsFromAnswer(answer));
  const responseSettings = audienceResponseSettings(interaction);
  const wordCloudRemaining = Math.max(0, responseSettings.submissionLimit - sentCount);
  const wordCloudFull = interaction.interaction_type === "word_cloud" && wordCloudRemaining === 0;
  const stickyNoteInputId = `sticky-note-${interaction.id}`;
  const audienceQuestionInputId = `audience-question-${interaction.id}`;
  const interactionQuestions = questionsForInteraction(questions, interaction.id);
  const choiceLocked = interaction.interaction_type === "single_choice"
    && Boolean(answer)
    && !responseSettings.allowChange;

  useEffect(() => {
    setChoiceSelection(choiceIdsFromAnswer(answer));
  }, [answer, interaction.id]);

  return (
    <article className={`audience-question audience-question-${interaction.interaction_type}`}>
      <span className="type-badge">{typeName(t, interaction.interaction_type)}</span>
      <h2>{interaction.prompt}</h2>
      {interaction.description && <p>{interaction.description}</p>}
      {interaction.interaction_type === "understanding" && (
        <div className="understanding-buttons">
          <button className={answer === "green" ? "selected green" : "green"} disabled={busy} onClick={() => submit({ level: "green" }, "green")}>{t("audience.green")}</button>
          <button className={answer === "yellow" ? "selected yellow" : "yellow"} disabled={busy} onClick={() => submit({ level: "yellow" }, "yellow")}>{t("audience.yellow")}</button>
          <button className={answer === "red" ? "selected red" : "red"} disabled={busy} onClick={() => submit({ level: "red" }, "red")}>{t("audience.red")}</button>
        </div>
      )}
      {interaction.interaction_type === "single_choice" && (
        <div className="choice-response">
          <div className="choice-buttons">
            {interaction.options.map((option, index) => (
              <button
                className={choiceSelection.includes(option.id) ? "selected" : ""}
                disabled={busy || choiceLocked}
                key={option.id}
                onClick={() => {
                  if (!responseSettings.multipleSelection) {
                    void submit({ option_id: option.id }, option.id);
                    return;
                  }
                  setChoiceSelection((current) => current.includes(option.id)
                    ? current.filter((id) => id !== option.id)
                    : [...current, option.id]);
                }}
              >
                <span>{String.fromCharCode(65 + index)}</span>{option.label}
              </button>
            ))}
          </div>
          {responseSettings.multipleSelection && <button
            className="choice-submit-button"
            disabled={busy || choiceLocked || choiceSelection.length === 0}
            onClick={() => submit({ option_ids: choiceSelection }, choiceSelection.join(","))}
          >{t("audience.submitChoice")}</button>}
        </div>
      )}
      {interaction.interaction_type === "word_cloud" && (
        <form className="text-response" onSubmit={async (event) => {
          event.preventDefault();
          const value = text.trim();
          if (!value || wordCloudFull) return;
          if (await submit({ text: value }, value)) setText("");
        }}>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            maxLength={200}
            placeholder={t("audience.textPlaceholder")}
            disabled={busy || wordCloudFull}
            rows={3}
          />
          <button disabled={busy || wordCloudFull || !text.trim()}>{t("audience.send")}</button>
        </form>
      )}
      {interaction.interaction_type === "qa" && (
        <div className="qa-audience">
          <form className="text-response sticky-note-composer" onSubmit={async (event) => {
            event.preventDefault();
            const value = questionBody.trim();
            if (!value) return;
            if (await submitQuestion(interaction.id, value)) setQuestionBody("");
          }}>
            <div className="sticky-note-composer-heading">
              <label htmlFor={stickyNoteInputId}>{t("qa.composerTitle")}</label>
              <small>{questionBody.length}/500</small>
            </div>
            <textarea
              id={stickyNoteInputId}
              name={`sticky_note_${interaction.id}`}
              autoComplete="off"
              value={questionBody}
              onChange={(event) => setQuestionBody(event.target.value)}
              maxLength={500}
              placeholder={t("qa.placeholder")}
              disabled={busy}
              rows={3}
            />
            <p>{t("qa.composerHint")}</p>
            <button type="submit" disabled={busy || !questionBody.trim()}>{t("qa.ask")}</button>
          </form>
          <QuestionList t={t} questions={interactionQuestions} busy={busy} onVote={voteQuestion} />
        </div>
      )}
      {interaction.interaction_type === "audience_qa" && (
        <div className="audience-qa-participant">
          <form className="audience-question-composer" onSubmit={async (event) => {
            event.preventDefault();
            const value = questionBody.trim();
            if (!value) return;
            if (await submitQuestion(interaction.id, value)) {
              setQuestionBody("");
              setQuestionSent(true);
            }
          }}>
            <div>
              <label htmlFor={audienceQuestionInputId}>{t("audienceQa.composerTitle")}</label>
              <small>{questionBody.length}/500</small>
            </div>
            <textarea
              id={audienceQuestionInputId}
              name={`audience_question_${interaction.id}`}
              autoComplete="off"
              value={questionBody}
              onChange={(event) => {
                setQuestionBody(event.target.value);
                setQuestionSent(false);
              }}
              maxLength={500}
              placeholder={t("audienceQa.placeholder")}
              disabled={busy}
              rows={3}
            />
            <button type="submit" disabled={busy || !questionBody.trim()}>{t("audienceQa.ask")}</button>
            {questionSent && <p className="audience-question-sent" role="status">{t("audienceQa.sent")}</p>}
          </form>
          <AudienceQuestionBoard
            t={t}
            questions={interactionQuestions}
            busy={busy}
            onVote={voteQuestion}
          />
        </div>
      )}
      {interaction.interaction_type === "word_cloud"
        ? sentCount > 0 && (
          <p className="answer-saved">
            {wordCloudFull
              ? t("audience.wordCloudLimit", { max: responseSettings.submissionLimit })
              : t("audience.wordCloudSaved", { remaining: wordCloudRemaining })}
          </p>
        )
        : answer && <p className="answer-saved">{responseSettings.allowChange ? t("audience.saved") : t("audience.changeLocked")}</p>}
    </article>
  );
}

function ResultsView({ t, live, state }: { t: Translate; live: LiveView | null; state: string }) {
  const interactions = live?.snapshot.current_cue_run?.interactions ?? [];
  return (
    <div className="audience-results">
      <p className="eyebrow">{state === "revealed" ? t("audience.results") : t("audience.closed")}</p>
      {live?.aggregates.map((item) => {
        const interaction = interactions.find((candidate) => candidate.id === item.interaction_id);
        return <section className="audience-result-interaction" key={item.interaction_id}>
          {interaction?.prompt && <h2>{interaction.prompt}</h2>}
          <AggregateBars t={t} aggregate={item.aggregate} />
        </section>;
      })}
      {interactions.map((interaction) => {
        const questions = questionsForInteraction(live?.questions ?? [], interaction.id);
        if (interaction.interaction_type === "qa" && questions.length) {
          return <section className="audience-result-interaction" key={interaction.id}><h2>{interaction.prompt}</h2><QuestionList t={t} questions={questions} busy /></section>;
        }
        if (interaction.interaction_type === "audience_qa") {
          return <section className="audience-result-interaction" key={interaction.id}><h2>{interaction.prompt}</h2><AudienceQuestionBoard t={t} questions={questions} busy /></section>;
        }
        return null;
      })}
    </div>
  );
}

export type AudienceStageMode = "waiting" | "open" | "results";

export function audienceStageMode(sessionStatus: string, cueState?: string): AudienceStageMode {
  if (sessionStatus !== "live" || !cueState || cueState === "ready") return "waiting";
  return cueState === "open" ? "open" : "results";
}

function mergeAudienceAnswers(
  sessionId: string,
  participantId: string,
  current: Record<string, string>,
  myResponses: LiveView["my_responses"] | undefined,
) {
  const next = { ...readStoredAnswers(sessionId, participantId), ...current };
  for (const item of myResponses ?? []) {
    const label = labelFromPayload(item.payload);
    if (label) next[item.interaction_id] = label;
  }
  storeAnswers(sessionId, participantId, next);
  return next;
}

export function labelFromPayload(payload: Record<string, unknown>) {
  if (typeof payload.level === "string") return payload.level;
  if (typeof payload.option_id === "string") return payload.option_id;
  if (Array.isArray(payload.option_ids)
    && payload.option_ids.length > 0
    && payload.option_ids.every((value) => typeof value === "string")) {
    return payload.option_ids.join(",");
  }
  if (typeof payload.text === "string") return payload.text;
  if (payload.understood === true) return "green";
  if (payload.understood === false) return "red";
  return undefined;
}

export function audienceResponseSettings(interaction?: Pick<SnapshotInteraction, "settings">) {
  const response = interaction?.settings.response;
  const record = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  const rawLimit = record.submission_limit;
  return {
    allowChange: typeof record.allow_change === "boolean" ? record.allow_change : true,
    multipleSelection: record.multiple_selection === true,
    submissionLimit: typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 10
      ? rawLimit
      : 3,
  };
}

function choiceIdsFromAnswer(answer?: string) {
  return answer?.split(",").filter(Boolean) ?? [];
}

function answersStorageKey(sessionId: string, participantId: string) {
  return `slide-helper-answers:${sessionId}:${participantId}`;
}

function readStoredAnswers(sessionId: string, participantId: string) {
  try {
    const raw = localStorage.getItem(answersStorageKey(sessionId, participantId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function storeAnswers(sessionId: string, participantId: string, answers: Record<string, string>) {
  localStorage.setItem(answersStorageKey(sessionId, participantId), JSON.stringify(answers));
}
