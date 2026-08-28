import { type FormEvent, useEffect, useRef, useState } from "react";

import type { Translate } from "./i18n";
import { defaultVisibility, interactionResultVisibility, typeName } from "./lib/interactions";
import {
  type InteractionPurpose,
  interactionPurposes,
  purposeRecommendation,
} from "./presenterTemplates";
import type { Cue, Interaction } from "./types";

export type ResultVisibility = "background" | "after_reveal";
export const DEFAULT_WORD_CLOUD_SUBMISSION_LIMIT = 3;
export const MAX_WORD_CLOUD_SUBMISSION_LIMIT = 10;

export type InteractionResponseSettings = {
  allow_change: boolean;
  multiple_selection: boolean;
  submission_limit: number;
  allow_duplicate: boolean;
};

export type InteractionDraft = {
  interaction_type: Interaction["interaction_type"];
  prompt: string;
  purpose: InteractionPurpose;
  visibility: ResultVisibility;
  options: string[];
  response: InteractionResponseSettings;
};

type InteractionWorkspaceProps = {
  t: Translate;
  busy: boolean;
  cue: Cue;
  item?: Interaction;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAutoSave?: (draft: InteractionDraft) => Promise<void>;
  onDelete?: () => void;
  onCancel?: () => void;
};

export function InteractionWorkspace({
  t,
  busy,
  cue,
  item,
  onSubmit,
  onAutoSave,
  onDelete,
  onCancel,
}: InteractionWorkspaceProps) {
  const initialPurpose = item ? purposeFrom(item) : "understanding";
  const recommended = purposeRecommendation(t, initialPurpose);
  const [purpose, setPurpose] = useState<InteractionPurpose>(initialPurpose);
  const [type, setType] = useState<Interaction["interaction_type"]>(item?.interaction_type ?? recommended.type);
  const [prompt, setPrompt] = useState(item?.prompt ?? recommended.prompt);
  const [options, setOptions] = useState(() => initialOptions(t, item));
  const [visibility, setVisibility] = useState<ResultVisibility>(() => item ? visibilityFrom(item) : defaultVisibility(recommended.type));
  const initialResponse = responseSettingsFromInteraction(item);
  const [allowChange, setAllowChange] = useState(initialResponse.allow_change);
  const [multipleSelection, setMultipleSelection] = useState(initialResponse.multiple_selection);
  const [submissionLimit, setSubmissionLimit] = useState(initialResponse.submission_limit);
  const [allowDuplicate, setAllowDuplicate] = useState(initialResponse.allow_duplicate);
  const draft: InteractionDraft = {
    interaction_type: type,
    prompt,
    purpose,
    visibility,
    options: type === "single_choice" ? options : [],
    response: {
      allow_change: allowChange,
      multiple_selection: multipleSelection,
      submission_limit: submissionLimit,
      allow_duplicate: allowDuplicate,
    },
  };
  const fingerprint = JSON.stringify(draft);
  const savedFingerprint = useRef(fingerprint);
  const autoSaveCallback = useRef(onAutoSave);
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    autoSaveCallback.current = onAutoSave;
  }, [onAutoSave]);

  useEffect(() => {
    if (!item || busy || autoSaveState === "saving" || !interactionDraftValid(draft)) return;
    if (fingerprint === savedFingerprint.current) return;
    const timer = window.setTimeout(() => {
      const save = autoSaveCallback.current;
      if (!save) return;
      const savingFingerprint = fingerprint;
      setAutoSaveState("saving");
      void save(draft)
        .then(() => {
          savedFingerprint.current = savingFingerprint;
          setAutoSaveState("saved");
        })
        .catch(() => setAutoSaveState("idle"));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [autoSaveState, busy, fingerprint, item]);

  function choosePurpose(nextPurpose: InteractionPurpose) {
    const previousRecommendation = purposeRecommendation(t, purpose);
    const nextRecommendation = purposeRecommendation(t, nextPurpose);
    setPurpose(nextPurpose);
    setType(nextRecommendation.type);
    setVisibility((current) => current === defaultVisibility(type) ? defaultVisibility(nextRecommendation.type) : current);
    if (!item || prompt === previousRecommendation.prompt) setPrompt(nextRecommendation.prompt);
    if (nextRecommendation.type === "single_choice" && options.length < 2) setOptions(emptyChoiceOptions(t));
  }

  function chooseType(nextType: Interaction["interaction_type"]) {
    setVisibility((current) => current === defaultVisibility(type) ? defaultVisibility(nextType) : current);
    setType(nextType);
    if (nextType === "single_choice" && options.length < 2) setOptions(emptyChoiceOptions(t));
  }

  function updateOption(index: number, value: string) {
    setOptions((current) => current.map((option, optionIndex) => optionIndex === index ? value : option));
  }

  function removeOption(index: number) {
    setOptions((current) => current.filter((_, optionIndex) => optionIndex !== index));
  }

  return (
    <form
      className={item ? "interaction-workspace" : "interaction-workspace creating"}
      onSubmit={(event) => item ? event.preventDefault() : onSubmit(event)}
    >
      <section className="interaction-stage" aria-label={t("interaction.canvasLabel")}>
        <div className="canvas-context">
          <span>{t("interaction.slideCanvas", { slide: cue.anchor_value ?? cue.position + 1 })}</span>
          <div className="canvas-context-actions">
            <strong>{typeName(t, type)}</strong>
            {onDelete && <button
              type="button"
              className="canvas-delete-button"
              disabled={busy}
              onClick={onDelete}
            >{t("common.delete")}</button>}
          </div>
        </div>
        <div className="interaction-canvas-shell">
          <div className={`interaction-canvas canvas-type-${type}`}>
            <span className={`type-badge type-${type}`}>{typeName(t, type)}</span>
            <label className="canvas-title-field">
              <span>{t("interaction.promptLabel")}</span>
              <textarea
                name="prompt"
                required
                maxLength={500}
                rows={2}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={t("interaction.promptPlaceholder")}
              />
            </label>
            <InteractionCanvasBody
              t={t}
              type={type}
              options={options}
              updateOption={updateOption}
              removeOption={removeOption}
              addOption={() => setOptions((current) => [...current, ""])}
            />
            <input type="hidden" name="options" value={options.join("\n")} />
            <span className="canvas-brand">SLIDEACT</span>
          </div>
          {!item && <div className="interaction-creation-hint" role="status">
            <strong>{t("interaction.createHintTitle")}</strong>
            <span>{t("interaction.createHintCopy")}</span>
          </div>}
        </div>
        <p className="canvas-help">{t("interaction.canvasHelp")}</p>
      </section>

      <aside className="interaction-inspector">
        <header>
          <small>{item ? t("interaction.editing") : t("interaction.creating")}</small>
          {item && <span className={`autosave-status ${autoSaveState}`}>
            {t(autoSaveState === "saving"
              ? "interaction.saving"
              : autoSaveState === "saved"
                ? "interaction.saved"
                : "interaction.autoSave")}
          </span>}
        </header>

        <section className="inspector-section">
          {!item && <label>
            <span>{t("interaction.purpose")}</span>
            <select name="interaction_purpose" value={purpose} onChange={(event) => choosePurpose(event.target.value as InteractionPurpose)}>
              {interactionPurposes.map((value) => <option value={value} key={value}>{t(`purpose.${value}`)}</option>)}
            </select>
          </label>}
          <label>
            <span>{t("interaction.typeLabel")}</span>
            <select name="interaction_type" value={type} onChange={(event) => chooseType(event.target.value as Interaction["interaction_type"])}>
              <option value="understanding">{t("interaction.understanding")}</option>
              <option value="single_choice">{t("interaction.choice")}</option>
              <option value="word_cloud">{t("interaction.wordCloud")}</option>
              <option value="qa">{t("interaction.qa")}</option>
            </select>
          </label>
        </section>

        <section className="inspector-section">
          <h4>{t("interaction.responseSettings")}</h4>
          <p className="inspector-section-help">{t("interaction.responseSettingsHelp")}</p>
          {type === "single_choice" && <>
            <label className="visibility-checkbox">
              <input
                type="checkbox"
                name="multiple_selection"
                checked={multipleSelection}
                onChange={(event) => setMultipleSelection(event.target.checked)}
              />
              <span className="checkbox-mark" aria-hidden="true">✓</span>
              <span><strong>{t("interaction.multipleSelection")}</strong><small>{t("interaction.multipleSelectionHelp")}</small></span>
            </label>
            <label className="visibility-checkbox">
              <input
                type="checkbox"
                name="allow_change"
                checked={allowChange}
                onChange={(event) => setAllowChange(event.target.checked)}
              />
              <span className="checkbox-mark" aria-hidden="true">✓</span>
              <span><strong>{t("interaction.allowChange")}</strong><small>{t("interaction.allowChangeHelp")}</small></span>
            </label>
          </>}
          {type === "word_cloud" && <>
            <label className="response-limit-field">
              <span>{t("interaction.wordCloudSubmissionLimit")}</span>
              <input
                type="number"
                name="submission_limit"
                min={1}
                max={MAX_WORD_CLOUD_SUBMISSION_LIMIT}
                value={submissionLimit}
                onChange={(event) => setSubmissionLimit(Number(event.target.value))}
              />
              <small>{t("interaction.wordCloudSubmissionLimitHelp")}</small>
            </label>
            <label className="visibility-checkbox">
              <input
                type="checkbox"
                name="allow_duplicate"
                checked={allowDuplicate}
                onChange={(event) => setAllowDuplicate(event.target.checked)}
              />
              <span className="checkbox-mark" aria-hidden="true">✓</span>
              <span><strong>{t("interaction.allowDuplicate")}</strong><small>{t("interaction.allowDuplicateHelp")}</small></span>
            </label>
          </>}
        </section>

        <section className="inspector-section">
          <h4>{t("interaction.resultSettings")}</h4>
          <p className="inspector-section-help">{t("interaction.resultSettingsHelp")}</p>
          <label className="result-visibility-option">
            <input
              type="radio"
              name="result_visibility"
              value="background"
              checked={visibility === "background"}
              onChange={() => setVisibility("background")}
            />
            <span className="radio-mark" aria-hidden="true" />
            <span><strong>{t("interaction.backgroundQuestion")}</strong><small>{t("interaction.backgroundQuestionHelp")}</small></span>
          </label>
          <label className="result-visibility-option">
            <input
              type="radio"
              name="result_visibility"
              value="after_reveal"
              checked={visibility === "after_reveal"}
              onChange={() => setVisibility("after_reveal")}
            />
            <span className="radio-mark" aria-hidden="true" />
            <span><strong>{t("interaction.publishLive")}</strong><small>{t("interaction.publishLiveHelp")}</small></span>
          </label>
        </section>

        {(!item || onCancel) && <div className="inspector-actions">
          {!item && <button className="primary-button" disabled={busy}>{t("interaction.create")}</button>}
          {onCancel && <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>}
        </div>}
      </aside>
    </form>
  );
}

function InteractionCanvasBody({ t, type, options, updateOption, removeOption, addOption }: {
  t: Translate;
  type: Interaction["interaction_type"];
  options: string[];
  updateOption: (index: number, value: string) => void;
  removeOption: (index: number) => void;
  addOption: () => void;
}) {
  if (type === "single_choice") {
    return (
      <div className="canvas-options">
        {options.map((option, index) => (
          <div className="canvas-option" key={index}>
            <span>{String.fromCharCode(65 + index)}</span>
            <input
              required
              maxLength={200}
              value={option}
              onChange={(event) => updateOption(index, event.target.value)}
              aria-label={t("interaction.optionNumber", { index: index + 1 })}
              placeholder={t("interaction.optionNumber", { index: index + 1 })}
            />
            {options.length > 2 && <button type="button" onClick={() => removeOption(index)} aria-label={t("interaction.removeOption", { index: index + 1 })}>×</button>}
          </div>
        ))}
        {options.length < 6 && <button type="button" className="add-option" onClick={addOption}>+ {t("interaction.addOption")}</button>}
      </div>
    );
  }

  if (type === "word_cloud") {
    return (
      <div className="canvas-word-cloud" aria-hidden="true">
        <span>{t("interaction.wordSampleIdeas")}</span>
        <span>{t("interaction.wordSampleLive")}</span>
        <span>{t("interaction.wordSampleTogether")}</span>
        <span>{t("interaction.wordSampleLearn")}</span>
        <span>{t("interaction.wordSampleShare")}</span>
      </div>
    );
  }

  if (type === "qa") {
    return (
      <div className="canvas-qa" aria-hidden="true">
        <div><i />{t("qa.placeholder")}</div>
        <div><i />{t("interaction.qaPreviewQuestion")}</div>
      </div>
    );
  }

  return (
    <div className="canvas-understanding" aria-hidden="true">
      <span className="understanding-green"><i>✓</i>{t("audience.green")}</span>
      <span className="understanding-yellow"><i>~</i>{t("audience.yellow")}</span>
      <span className="understanding-red"><i>!</i>{t("audience.red")}</span>
    </div>
  );
}

function emptyChoiceOptions(t: Translate) {
  return Array.from({ length: 4 }, (_, index) => t("interaction.optionNumber", { index: index + 1 }));
}

function initialOptions(t: Translate, item?: Interaction) {
  if (!item) return emptyChoiceOptions(t);
  const options = item.options.map((option) => option.label);
  return options.length >= 2 ? options : emptyChoiceOptions(t);
}

function purposeFrom(item: Interaction): InteractionPurpose {
  const purpose = item.settings.purpose;
  return typeof purpose === "string" && interactionPurposes.includes(purpose as InteractionPurpose)
    ? purpose as InteractionPurpose
    : "understanding";
}

function visibilityFrom(item: Interaction): ResultVisibility {
  return interactionResultVisibility(item.settings);
}

export function resultVisibilityFromForm(value: FormDataEntryValue | null): ResultVisibility {
  return value === "background" ? "background" : "after_reveal";
}

export function responseSettingsFromForm(
  interactionType: Interaction["interaction_type"],
  data: FormData,
): InteractionResponseSettings {
  const rawSubmissionLimit = data.get("submission_limit");
  return {
    allow_change: interactionType === "single_choice" ? data.get("allow_change") === "on" : true,
    multiple_selection: interactionType === "single_choice" && data.get("multiple_selection") === "on",
    submission_limit: interactionType === "word_cloud"
      ? normalizeSubmissionLimit(typeof rawSubmissionLimit === "string" && rawSubmissionLimit
        ? Number(rawSubmissionLimit)
        : DEFAULT_WORD_CLOUD_SUBMISSION_LIMIT)
      : DEFAULT_WORD_CLOUD_SUBMISSION_LIMIT,
    allow_duplicate: interactionType !== "word_cloud" || data.get("allow_duplicate") === "on",
  };
}

export function responseSettingsFromInteraction(item?: Interaction): InteractionResponseSettings {
  const response = item?.settings.response;
  const record = typeof response === "object" && response !== null
    ? response as Record<string, unknown>
    : {};
  return {
    allow_change: typeof record.allow_change === "boolean" ? record.allow_change : true,
    multiple_selection: record.multiple_selection === true,
    submission_limit: normalizeSubmissionLimit(record.submission_limit),
    allow_duplicate: typeof record.allow_duplicate === "boolean" ? record.allow_duplicate : true,
  };
}

function normalizeSubmissionLimit(value: unknown) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(Math.max(value, 1), MAX_WORD_CLOUD_SUBMISSION_LIMIT)
    : DEFAULT_WORD_CLOUD_SUBMISSION_LIMIT;
}

export function interactionDraftValid(draft: InteractionDraft) {
  const prompt = draft.prompt.trim();
  if (!prompt || prompt.length > 500) return false;
  if (!Number.isInteger(draft.response.submission_limit)
    || draft.response.submission_limit < 1
    || draft.response.submission_limit > MAX_WORD_CLOUD_SUBMISSION_LIMIT) return false;
  if (draft.interaction_type !== "single_choice") return true;
  return draft.options.length >= 2
    && draft.options.length <= 6
    && draft.options.every((option) => {
      const label = option.trim();
      return Boolean(label) && label.length <= 200;
    });
}
