import { type FormEvent, useState } from "react";

import type { Translate } from "./i18n";
import { defaultVisibility, typeName } from "./lib/interactions";
import {
  type InteractionPurpose,
  interactionPurposes,
  purposeRecommendation,
} from "./presenterTemplates";
import type { Cue, Interaction } from "./types";

type ResultVisibility = "after_reveal" | "live";

type InteractionWorkspaceProps = {
  t: Translate;
  busy: boolean;
  cue: Cue;
  item?: Interaction;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onDelete?: () => void;
  onCancel?: () => void;
};

export function InteractionWorkspace({
  t,
  busy,
  cue,
  item,
  onSubmit,
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
    <form className={item ? "interaction-workspace" : "interaction-workspace creating"} onSubmit={onSubmit}>
      <section className="interaction-stage" aria-label={t("interaction.canvasLabel")}>
        {!item && <div className="interaction-creation-hint" role="status">
          <strong>{t("interaction.createHintTitle")}</strong>
          <span>{t("interaction.createHintCopy")}</span>
        </div>}
        <div className="canvas-context">
          <span>{t("interaction.slideCanvas", { slide: cue.anchor_value ?? cue.position + 1 })}</span>
          <strong>{typeName(t, type)}</strong>
        </div>
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
        <p className="canvas-help">{t("interaction.canvasHelp")}</p>
      </section>

      <aside className="interaction-inspector">
        <header>
          <small>{item ? t("interaction.editing") : t("interaction.creating")}</small>
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
          <label className="visibility-checkbox">
            <input
              type="checkbox"
              name="publish_live"
              checked={visibility === "live"}
              onChange={(event) => setVisibility(event.target.checked ? "live" : "after_reveal")}
            />
            <span className="checkbox-mark" aria-hidden="true">✓</span>
            <span><strong>{t("interaction.publishLive")}</strong><small>{visibility === "live" ? t("interaction.publishLiveHelp") : t("interaction.publishAfterHelp")}</small></span>
          </label>
        </section>

        <div className="inspector-actions">
          <button className="primary-button" disabled={busy}>{item ? t("common.save") : t("interaction.create")}</button>
          {onCancel && <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>}
          {onDelete && <button type="button" className="danger-button" disabled={busy} onClick={onDelete}>{t("common.delete")}</button>}
        </div>
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
        <button type="button" className="add-option" onClick={addOption}>+ {t("interaction.addOption")}</button>
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
  const results = item.settings.results;
  const visibility = typeof results === "object" && results !== null
    ? (results as Record<string, unknown>).audience_visibility
    : null;
  return visibility === "live" ? "live" : "after_reveal";
}

export function liveVisibilityFromForm(value: FormDataEntryValue | null): ResultVisibility {
  return value === "on" ? "live" : "after_reveal";
}
