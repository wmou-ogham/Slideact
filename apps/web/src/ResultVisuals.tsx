import { memo, type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Wordcloud } from "@visx/wordcloud";

import type { Translate } from "./i18n";
import { WORD_CLOUD_THEME } from "./projectionTheme";
import { ProjectionHeading } from "./TypewriterText";
import type { Aggregate, Question } from "./types";
import { useProjectionThemeValue } from "./useProjectionTheme";

export type QuestionCardLayout = "regular" | "condensed" | "compact" | "wide";

export function questionCardLayout(body: string): QuestionCardLayout {
  const length = [...body.trim()].length;
  if (length > 84) return "wide";
  if (length > 48) return "compact";
  if (length > 26) return "condensed";
  return "regular";
}

export function visibleProjectionQuestions(questions: Question[]) {
  return questions.filter((question) => question.status !== "hidden");
}

export function questionsForInteraction(questions: Question[], interactionId: string) {
  return questions.filter((question) => question.interaction_id === interactionId);
}

export function audienceQuestionQueue(questions: Question[]) {
  const active = questions.filter((question) => !matchesQuestionStatus(question, "answered", "hidden"));
  const current = active.find((question) => question.status === "pinned") ?? active[0] ?? null;
  return {
    current,
    waiting: current ? active.filter((question) => question.id !== current.id) : [],
  };
}

export function moderationQuestionOrder(questions: Question[]) {
  const rank: Record<Question["status"], number> = {
    pinned: 0,
    visible: 1,
    highlighted: 1,
    hidden: 2,
    pending: 2,
    answered: 3,
  };
  return questions
    .map((question, index) => ({ question, index }))
    .sort((left, right) => rank[left.question.status] - rank[right.question.status] || left.index - right.index)
    .map(({ question }) => question);
}

function matchesQuestionStatus(question: Question, ...statuses: Question["status"][]) {
  return statuses.includes(question.status);
}

export function QuestionList({ t, questions, busy, onVote }: {
  t: Translate;
  questions: Question[];
  busy: boolean;
  onVote?: (questionId: string) => Promise<void>;
}) {
  if (!questions.length) return <p className="qa-empty">{t("qa.empty")}</p>;
  return (
    <div className="question-list">
      {questions.map((question) => {
        const layout = questionCardLayout(question.body);
        const signed = Boolean(question.display_name);
        return (
          <article className={`question-card question-${question.status} question-card-${layout}${signed ? " question-card-signed" : ""}`} key={question.id}>
            <div>
              {question.status === "pinned" && <span className="question-status">{t("qa.pinned")}</span>}
              {question.status === "highlighted" && <span className="question-status">{t("qa.highlighted")}</span>}
              <p>{question.body}</p>
              {question.status === "answered" && <small className="question-status">{t("qa.answered")}</small>}
            </div>
            {question.display_name && <small className="question-author">— {question.display_name}</small>}
            <QuestionVote t={t} question={question} busy={busy} onVote={onVote} />
          </article>
        );
      })}
    </div>
  );
}

export function AudienceQuestionBoard({ t, questions, busy, onVote }: {
  t: Translate;
  questions: Question[];
  busy: boolean;
  onVote?: (questionId: string) => Promise<void>;
}) {
  const { current, waiting } = audienceQuestionQueue(questions);
  if (!current) return <p className="qa-empty">{t("audienceQa.empty")}</p>;
  const visibleWaiting = waiting.slice(0, 3);
  const currentLayout = questionCardLayout(current.body);
  return (
    <div className="audience-qa-board">
      <article className={`audience-qa-current audience-qa-current-${currentLayout}${current.display_name ? " signed" : ""}`} key={current.id}>
        <small className="audience-qa-section-label">{t("audienceQa.current")}</small>
        <p>{current.body}</p>
        {current.display_name && <small className="audience-qa-author">— {current.display_name}</small>}
        <QuestionVote t={t} question={current} busy={busy} onVote={onVote} />
      </article>
      {waiting.length > 0 && <section className="audience-qa-waiting">
        <header>
          <strong>{t("audienceQa.waiting", { count: waiting.length })}</strong>
          {waiting.length > visibleWaiting.length && <small>{t("audienceQa.more", { count: waiting.length - visibleWaiting.length })}</small>}
        </header>
        <div>
          {visibleWaiting.map((question) => (
            <article className={question.display_name ? "signed" : ""} key={question.id}>
              <p>{question.body}</p>
              {question.display_name && <small className="audience-qa-author">— {question.display_name}</small>}
              <QuestionVote t={t} question={question} busy={busy} onVote={onVote} />
            </article>
          ))}
        </div>
      </section>}
    </div>
  );
}

function QuestionVote({ t, question, busy, onVote }: {
  t: Translate;
  question: Question;
  busy: boolean;
  onVote?: (questionId: string) => Promise<void>;
}) {
  return onVote ? (
    <button
      className={question.voted_by_me ? "question-vote selected" : "question-vote"}
      disabled={busy}
      type="button"
      onClick={() => onVote(question.id)}
      aria-label={t("qa.votes", { count: question.votes })}
    >
      <ThumbIcon /><b>{question.votes}</b>
    </button>
  ) : (
    <span className="question-vote question-vote-static" aria-label={t("qa.votes", { count: question.votes })}>
      <ThumbIcon /><b>{question.votes}</b>
    </span>
  );
}

function ThumbIcon() {
  return (
    <svg className="question-vote-icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d="M8 10.25 11.35 3.8a1.7 1.7 0 0 1 3.2.92v4.03h3.9a2 2 0 0 1 1.94 2.49l-1.57 6.2a2.5 2.5 0 0 1-2.42 1.88H8m0-9.07v9.07m0-9.07H5a1.4 1.4 0 0 0-1.4 1.4v6.27A1.4 1.4 0 0 0 5 19.32h3" />
    </svg>
  );
}

export function AggregateBars({ t, aggregate, onToggleWordPin }: {
  t: Translate;
  aggregate: Aggregate;
  onToggleWordPin?: (text: string, pinned: boolean) => void;
}) {
  if (aggregate.interaction_type === "understanding") {
    const segments = [
      ["green", aggregate.green_percent ?? aggregate.understood_percent ?? 0],
      ["yellow", aggregate.yellow_percent ?? 0],
      ["red", aggregate.red_percent ?? 0],
    ] as const;
    return <div className="understanding-result">{segments.map(([name, percent]) => <div key={name} className={name} style={{ width: `${percent}%` }}><span>{Math.round(percent)}%</span></div>)}</div>;
  }
  if (aggregate.interaction_type === "word_cloud") {
    return (
      <WordCloudResult
        label={t("interaction.wordCloud")}
        entries={aggregate.entries ?? []}
        pinned={aggregate.pinned ?? []}
        onTogglePin={onToggleWordPin}
        pinLabel={t("wordCloud.pin")}
        unpinLabel={t("wordCloud.unpin")}
      />
    );
  }
  return <div className="result-options">{aggregate.options?.map((option) => {
    const percent = aggregate.total_responses ? Math.round(option.count * 100 / aggregate.total_responses) : 0;
    return <div key={option.option_id}><span>{option.label}</span><div className="result-track"><i style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>;
  })}</div>;
}

export function CueResultVisuals({ t, interactions, questions, onToggleWordPin }: {
  t: Translate;
  interactions: Array<{
    id: string;
    prompt: string;
    interaction_type: string;
    results_visible?: boolean;
    aggregate?: Aggregate | null;
  }>;
  questions: Question[];
  onToggleWordPin?: (interactionId: string, text: string, pinned: boolean) => void;
}) {
  const multi = interactions.length > 1;
  const theme = useProjectionThemeValue();
  return (
    <div className="projection-visuals">
      {interactions.map((interaction) => {
        const interactionQuestions = questionsForInteraction(questions, interaction.id);
        const displayedQuestions = visibleProjectionQuestions(interactionQuestions);
        return <article className={`projection-interaction projection-interaction-${interaction.interaction_type}`} key={interaction.id}>
          {multi && <h2><ProjectionHeading theme={theme} text={interaction.prompt} /></h2>}
          {interaction.interaction_type === "qa" ? (
            interaction.results_visible !== false && displayedQuestions.length
              ? <div className="projection-questions"><QuestionList t={t} questions={displayedQuestions} busy /></div>
              : <span className="projection-empty">{t(interaction.results_visible !== false ? "qa.empty" : "projection.noResults")}</span>
          ) : interaction.interaction_type === "audience_qa" ? (
            interaction.results_visible !== false
              ? <div className="projection-audience-qa"><AudienceQuestionBoard t={t} questions={interactionQuestions} busy /></div>
              : <span className="projection-empty">{t("projection.noResults")}</span>
          ) : interaction.aggregate ? (
            <AggregateBars
              t={t}
              aggregate={interaction.aggregate}
              onToggleWordPin={onToggleWordPin
                ? (text, pinned) => onToggleWordPin(interaction.id, text, pinned)
                : undefined}
            />
          ) : (
            <span className="projection-empty">{t("projection.noResults")}</span>
          )}
        </article>;
      })}
    </div>
  );
}

const WORD_CLOUD_ANGLES = [0, 0, 0, -7, 7, -13, 13, -20, 20];
const WORD_CLOUD_RANDOM = () => 0.5;
const WORD_CLOUD_WIDTH = 720;
const WORD_CLOUD_HEIGHT = 400;
const WORD_CLOUD_SINGLE_SIZE = WORD_CLOUD_HEIGHT / 3;
const WORD_CLOUD_COLLISION_PADDING = 8;
const WORD_CLOUD_SEARCH_STEP = 10;
const WORD_CLOUD_MIN_SIZE = 12;
const WORD_CLOUD_TARGET_OCCUPANCY = 0.7;
const WORD_CLOUD_MAX_FLOATING_WORDS = 6;
const WORD_CLOUD_ENTER_TIMEOUT_MS = 520;
const WORD_CLOUD_POP_TIMEOUT_MS = 260;

export function wordCloudSizeRange(wordCount: number): { minSize: number; maxSize: number } {
  if (wordCount <= 1) return { minSize: WORD_CLOUD_SINGLE_SIZE, maxSize: WORD_CLOUD_SINGLE_SIZE };
  return { minSize: 32, maxSize: 92 };
}

function wordCloudBaseFontSize(
  word: { text: string; value: number },
  minimum: number,
  maximum: number,
  wordCount: number,
): number {
  const { minSize, maxSize } = wordCloudSizeRange(wordCount);
  const t = maximum === minimum ? 1 : (word.value - minimum) / (maximum - minimum);
  const size = minSize + t * (maxSize - minSize);
  const maxWidth = WORD_CLOUD_WIDTH * 0.86;
  const estimated = Math.max(1, word.text.length) * 0.62 * size;
  if (estimated <= maxWidth) return size;
  return maxWidth / (Math.max(1, word.text.length) * 0.62);
}

function estimateWordCloudArea(word: { text: string }, size: number) {
  const padding = Math.max(10, size * 0.18);
  return (estimateWordWidth(word.text, size) + padding * 2) * (size * 1.18 + padding);
}

/**
 * Keep the original type scale while the estimated glyph area is below 70%
 * of the canvas. Once the cloud is denser than that, shrink every word by the
 * same ratio so frequency differences and the centre-weighted shape survive.
 */
export function wordCloudDensityScale(
  words: Array<{ text: string; value: number }>,
  minimum: number,
  maximum: number,
): number {
  if (!words.length) return 1;
  const baseSizes = words.map((word) => wordCloudBaseFontSize(word, minimum, maximum, words.length));
  const estimatedArea = words.reduce(
    (total, word, index) => total + estimateWordCloudArea(word, baseSizes[index] ?? WORD_CLOUD_MIN_SIZE),
    0,
  );
  const targetArea = WORD_CLOUD_WIDTH * WORD_CLOUD_HEIGHT * WORD_CLOUD_TARGET_OCCUPANCY;
  if (estimatedArea <= targetArea) return 1;
  return Math.max(0.24, Math.sqrt(targetArea / estimatedArea));
}

export function wordCloudFontSize(
  word: { text: string; value: number },
  minimum: number,
  maximum: number,
  wordCount: number,
  densityScale = 1,
): number {
  return wordCloudBaseFontSize(word, minimum, maximum, wordCount) * densityScale;
}

type WordCloudGlyph = {
  text?: string;
  value?: number;
  font?: string;
  weight?: string | number;
  rotate?: number;
  size?: number;
  x?: number;
  y?: number;
};

export type PositionedWordCloudGlyph = WordCloudGlyph & {
  text: string;
  rotate: number;
  size: number;
  x: number;
  y: number;
};

type WordCloudBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function wordTone(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wordCloudRotate(word: { text: string }, rotate: boolean): number {
  if (!rotate) return 0;
  return WORD_CLOUD_ANGLES[wordTone(word.text) % WORD_CLOUD_ANGLES.length];
}

function wordMotionStyle(text: string): CSSProperties {
  const tone = wordTone(text);
  const driftX = 4 + (tone % 5);
  const driftY = 5 + ((tone >>> 4) % 6);
  return {
    "--drift-x": `${driftX}px`,
    "--drift-x-back": `${driftX * -0.7}px`,
    "--drift-y": `${driftY}px`,
    "--drift-y-up": `${-driftY}px`,
    "--enter-delay": `${(tone % 7) * 0.025}s`,
    "--float-delay": `${0.55 + ((tone >>> 8) % 18) / 10}s`,
    "--float-duration": `${4.1 + (tone % 5) * 0.15}s`,
  } as CSSProperties;
}

/** Limit perpetual decorative motion to a small, deterministic set. */
export function wordCloudFloatingTexts(
  words: Array<{ text: string; value: number }>,
  limit = WORD_CLOUD_MAX_FLOATING_WORDS,
): ReadonlySet<string> {
  if (limit <= 0) return new Set();
  return new Set(
    [...words]
      .sort((left, right) => (
        right.value - left.value
        || wordTone(left.text) - wordTone(right.text)
        || left.text.localeCompare(right.text)
      ))
      .slice(0, limit)
      .map((word) => word.text),
  );
}

function estimateWordWidth(text: string, size: number) {
  return [...text].reduce((width, character) => width + (character.charCodeAt(0) > 255 ? size : size * 0.62), 0);
}

function wordCloudBounds(word: PositionedWordCloudGlyph): WordCloudBounds {
  const halfWidth = (estimateWordWidth(word.text, word.size) + Math.max(12, word.size * 0.2)) / 2;
  const top = -word.size * 0.88;
  const bottom = word.size * 0.34;
  const radians = word.rotate * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [-halfWidth, top],
    [halfWidth, top],
    [-halfWidth, bottom],
    [halfWidth, bottom],
  ].map(([x, y]) => ({
    x: word.x + x * cosine - y * sine,
    y: word.y + x * sine + y * cosine,
  }));
  return {
    left: Math.min(...corners.map((corner) => corner.x)),
    right: Math.max(...corners.map((corner) => corner.x)),
    top: Math.min(...corners.map((corner) => corner.y)),
    bottom: Math.max(...corners.map((corner) => corner.y)),
  };
}

export function wordCloudWordsOverlap(
  left: PositionedWordCloudGlyph,
  right: PositionedWordCloudGlyph,
  padding = WORD_CLOUD_COLLISION_PADDING,
) {
  const leftBounds = wordCloudBounds(left);
  const rightBounds = wordCloudBounds(right);
  return leftBounds.left < rightBounds.right + padding
    && leftBounds.right + padding > rightBounds.left
    && leftBounds.top < rightBounds.bottom + padding
    && leftBounds.bottom + padding > rightBounds.top;
}

function wordFitsCanvas(word: PositionedWordCloudGlyph, width: number, height: number) {
  const bounds = wordCloudBounds(word);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return bounds.left >= -halfWidth
    && bounds.right <= halfWidth
    && bounds.top >= -halfHeight
    && bounds.bottom <= halfHeight;
}

function findAvailableWordPosition(
  word: PositionedWordCloudGlyph,
  occupied: PositionedWordCloudGlyph[],
  width: number,
  height: number,
) {
  const maximumRadius = Math.ceil(Math.hypot(width, height));
  const startAngle = wordTone(word.text) % 360 * Math.PI / 180;
  for (let radius = WORD_CLOUD_SEARCH_STEP; radius <= maximumRadius; radius += WORD_CLOUD_SEARCH_STEP) {
    const samples = Math.max(8, Math.ceil(2 * Math.PI * radius / WORD_CLOUD_SEARCH_STEP));
    for (let index = 0; index < samples; index += 1) {
      const angle = startAngle + index * 2 * Math.PI / samples;
      const candidate = {
        ...word,
        x: word.x + Math.cos(angle) * radius,
        y: word.y + Math.sin(angle) * radius,
      };
      if (wordFitsCanvas(candidate, width, height)
        && occupied.every((placed) => !wordCloudWordsOverlap(candidate, placed))) {
        return candidate;
      }
    }
  }
  return null;
}

function wordCloudOverlapArea(left: PositionedWordCloudGlyph, right: PositionedWordCloudGlyph) {
  const leftBounds = wordCloudBounds(left);
  const rightBounds = wordCloudBounds(right);
  const width = Math.max(0, Math.min(leftBounds.right, rightBounds.right) - Math.max(leftBounds.left, rightBounds.left));
  const height = Math.max(0, Math.min(leftBounds.bottom, rightBounds.bottom) - Math.max(leftBounds.top, rightBounds.top));
  return width * height;
}

function fitWordInsideCanvas<T extends PositionedWordCloudGlyph>(word: T, width: number, height: number): T {
  let fitted = { ...word, x: 0, y: 0 } as T;
  while (!wordFitsCanvas(fitted, width, height) && fitted.size > 4) {
    fitted = { ...fitted, size: fitted.size * 0.85 };
  }
  return fitted;
}

/**
 * A saturated cloud should degrade to slight overlap, never a missing answer.
 * The deterministic grid starts at a text-derived offset so fallback words do
 * not all pile into the centre.
 */
function findLeastCrowdedWordPosition<T extends PositionedWordCloudGlyph>(
  word: T,
  occupied: PositionedWordCloudGlyph[],
  width: number,
  height: number,
): T {
  const fitted = fitWordInsideCanvas({ ...word, size: Math.min(word.size, WORD_CLOUD_MIN_SIZE) }, width, height);
  const bounds = wordCloudBounds(fitted);
  const minimumX = -width / 2 - bounds.left;
  const maximumX = width / 2 - bounds.right;
  const minimumY = -height / 2 - bounds.top;
  const maximumY = height / 2 - bounds.bottom;
  const step = Math.max(10, Math.floor(fitted.size * 0.8));
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = minimumY; y <= maximumY; y += step) {
    for (let x = minimumX; x <= maximumX; x += step) candidates.push({ x, y });
  }
  if (!candidates.length) return fitted;

  const offset = wordTone(word.text) % candidates.length;
  let best = { ...fitted, ...candidates[offset] } as T;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candidates.length; index += 1) {
    const point = candidates[(offset + index) % candidates.length];
    const candidate = { ...fitted, ...point } as T;
    const score = occupied.reduce((total, current) => total + wordCloudOverlapArea(candidate, current), 0);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
      if (score === 0) break;
    }
  }
  return best;
}

/**
 * d3-cloud may omit words that do not fit during an asynchronous layout pass.
 * Preserve its placed words and deterministically fit every missing aggregate
 * entry, shrinking only the missing entry when necessary.
 */
export function restoreMissingWordCloudWords<T extends PositionedWordCloudGlyph>(
  placed: T[],
  missing: T[],
  width = WORD_CLOUD_WIDTH,
  height = WORD_CLOUD_HEIGHT,
): T[] {
  if (!missing.length) return placed;
  const occupied: PositionedWordCloudGlyph[] = [...placed];
  const restored: T[] = [];
  for (const word of missing) {
    let size = word.size;
    let next: T | null = null;
    while (size >= WORD_CLOUD_MIN_SIZE && !next) {
      const candidate = { ...word, size } as T;
      if (wordFitsCanvas(candidate, width, height)
        && occupied.every((current) => !wordCloudWordsOverlap(candidate, current))) {
        next = candidate;
      } else {
        next = findAvailableWordPosition(candidate, occupied, width, height) as T | null;
      }
      size = Math.floor(size * 0.85);
    }
    if (!next) next = findLeastCrowdedWordPosition(word, occupied, width, height);
    occupied.push(next);
    restored.push(next);
  }
  return [...placed, ...restored];
}

/**
 * Keep pinned words as fixed anchors while giving every other word a chance
 * to move around them. The cloud layout can be rebuilt when counts change,
 * but a pin should not turn that rebuild into a jump for the presenter.
 */
export function reflowWordCloudAroundPinned<T extends PositionedWordCloudGlyph>(
  placed: T[],
  pinned: T[],
  width = WORD_CLOUD_WIDTH,
  height = WORD_CLOUD_HEIGHT,
): T[] {
  if (!pinned.length) return placed;

  const pinnedByText = new Map(pinned.map((word) => [word.text, word]));
  const occupied: PositionedWordCloudGlyph[] = [...pinnedByText.values()];
  return placed.map((word) => {
    const fixed = pinnedByText.get(word.text);
    if (fixed) return fixed;

    let next = word;
    if (!wordFitsCanvas(word, width, height)
      || occupied.some((current) => wordCloudWordsOverlap(word, current))) {
      next = findAvailableWordPosition(word, occupied, width, height) as T | null
        ?? findLeastCrowdedWordPosition(word, occupied, width, height);
    }
    occupied.push(next);
    return next;
  });
}

type WordCloudWordProps = {
  colors: readonly string[];
  entering: boolean;
  floating: boolean;
  hot: boolean;
  interactive: boolean;
  motionStyle: CSSProperties;
  onTogglePin: (text: string, pinned: boolean) => void;
  pinLabel: string;
  pinned: boolean;
  popping: boolean;
  unpinLabel: string;
  word: PositionedWordCloudGlyph;
};

const WordCloudWord = memo(function WordCloudWord({
  colors,
  entering,
  floating,
  hot,
  interactive,
  motionStyle,
  onTogglePin,
  pinLabel,
  pinned,
  popping,
  unpinLabel,
  word,
}: WordCloudWordProps) {
  const text = word.text;
  const boxWidth = pinned ? estimateWordWidth(text, word.size) + Math.max(16, word.size * 0.35) : 0;
  const boxHeight = pinned ? word.size * 1.22 : 0;
  const togglePin = () => onTogglePin(text, !pinned);

  return (
    <g
      className={`${interactive ? "word-cloud-hit " : ""}word-cloud-position${pinned ? " is-pinned" : ""}`}
      style={{ transform: `translate(${word.x}px, ${word.y}px)` }}
      onClick={interactive ? (event) => {
        togglePin();
        if (event.detail) event.currentTarget.blur();
      } : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive ? pinned : undefined}
      aria-label={interactive ? (pinned ? unpinLabel : pinLabel) : undefined}
      onKeyDown={interactive ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          togglePin();
        }
      } : undefined}
    >
      <g transform={`rotate(${word.rotate})`}>
        <g
          className={`word-cloud-enter${entering ? " is-entering" : ""}${popping ? " is-popping" : ""}`}
          style={motionStyle}
        >
          <g className={`word-cloud-float${pinned ? " is-pinned" : ""}${floating ? " is-floating" : ""}${hot ? " is-hot" : ""}`}>
            {pinned && (
              <rect
                className="word-cloud-pin-box"
                x={-boxWidth / 2}
                y={-word.size * 0.88}
                width={boxWidth}
                height={boxHeight}
                rx={Math.max(6, word.size * 0.12)}
              />
            )}
            <text
              fill={colors[wordTone(text) % colors.length]}
              fontFamily={word.font}
              fontSize={word.size}
              fontWeight={word.weight}
              textAnchor="middle"
            >
              {text}
            </text>
          </g>
        </g>
      </g>
    </g>
  );
});

function WordCloudResult({ entries, label, pinned, onTogglePin, pinLabel, unpinLabel }: {
  entries: Array<{ text: string; count: number }>;
  label: string;
  pinned: string[];
  onTogglePin?: (text: string, pinned: boolean) => void;
  pinLabel: string;
  unpinLabel: string;
}) {
  const theme = useProjectionThemeValue();
  const palette = WORD_CLOUD_THEME[theme];
  const rotate = useMemo(
    () => (word: { text: string }) => wordCloudRotate(word, palette.rotate),
    [palette.rotate],
  );
  const wordSignature = wordCloudLayoutSignature(entries);
  const words = useMemo(
    () => entries.slice(0, 80).map((entry) => ({ text: entry.text, value: entry.count })),
    // Only rebuild when visible text/count pairs change, not when the parent sends a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wordSignature],
  );
  const seen = useRef(new Set<string>());
  const previousCounts = useRef(new Map<string, number>());
  const pinnedPositions = useRef(new Map<string, Pick<PositionedWordCloudGlyph, "x" | "y" | "rotate">>());
  const completedLayout = useRef<PositionedWordCloudGlyph[]>([]);
  const completedLayoutRevision = useRef<string | null>(null);
  const cloudWordsReference = useRef<WordCloudGlyph[] | null>(null);
  const processedLayout = useRef<{
    cloudWords: WordCloudGlyph[];
    pinnedSignature: string;
    revision: string;
    words: PositionedWordCloudGlyph[];
  } | null>(null);
  const enterTimers = useRef(new Set<number>());
  const pinnedSignature = JSON.stringify([...pinned].sort());
  const pinnedSet = useMemo(
    () => new Set(pinned),
    // Pin order has no visual meaning; avoid rebuilding for an equivalent array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedSignature],
  );
  const [enteringState, setEnteringState] = useState<ReadonlySet<string>>(new Set());
  const [popping, setPopping] = useState<ReadonlySet<string>>(new Set());
  const entering = useMemo(() => {
    const next = new Set(enteringState);
    for (const word of words) {
      if (!seen.current.has(word.text)) next.add(word.text);
    }
    return next;
  }, [enteringState, words]);
  const { minimum, maximum } = useMemo(() => {
    if (!words.length) return { minimum: 0, maximum: 1 };
    let nextMinimum = Number.POSITIVE_INFINITY;
    let nextMaximum = Number.NEGATIVE_INFINITY;
    for (const word of words) {
      nextMinimum = Math.min(nextMinimum, word.value);
      nextMaximum = Math.max(nextMaximum, word.value);
    }
    return { minimum: nextMinimum, maximum: nextMaximum };
  }, [words]);
  const densityScale = useMemo(
    () => wordCloudDensityScale(words, minimum, maximum),
    [maximum, minimum, words],
  );
  const { maxSize } = wordCloudSizeRange(words.length);
  const layoutRevision = `${theme}\n${wordSignature}`;
  const wordReferences = useMemo(() => new Set<object>(words), [words]);
  const visibleTexts = useMemo(() => new Set(words.map((word) => word.text)), [words]);
  const floatingTexts = useMemo(() => wordCloudFloatingTexts(words), [words]);
  const motionStyles = useMemo(
    () => new Map(words.map((word) => [word.text, wordMotionStyle(word.text)])),
    [words],
  );
  const fontSize = useMemo(
    () => (word: { text: string; value: number }) => wordCloudFontSize(word, minimum, maximum, words.length, densityScale),
    [densityScale, minimum, maximum, words.length],
  );
  const fontWeight = useMemo(
    () => (word: { value: number }) => (word.value >= maximum * 0.55 ? 800 : 650),
    [maximum],
  );
  const onTogglePinRef = useRef(onTogglePin);
  useEffect(() => {
    onTogglePinRef.current = onTogglePin;
  }, [onTogglePin]);
  const toggleWordPin = useCallback((text: string, nextPinned: boolean) => {
    onTogglePinRef.current?.(text, nextPinned);
  }, []);

  useEffect(() => () => {
    enterTimers.current.forEach((timer) => window.clearTimeout(timer));
    enterTimers.current.clear();
  }, []);

  useEffect(() => {
    if (!words.length) {
      enterTimers.current.forEach((timer) => window.clearTimeout(timer));
      enterTimers.current.clear();
      seen.current.clear();
      previousCounts.current.clear();
      setEnteringState(new Set());
      setPopping(new Set());
      return;
    }
    const newcomers = words.filter((word) => !seen.current.has(word.text)).map((word) => word.text);
    const nextPop = new Set<string>();
    for (const word of words) {
      if (
        seen.current.has(word.text)
        && !enteringState.has(word.text)
        && (previousCounts.current.get(word.text) ?? word.value) < word.value
      ) {
        nextPop.add(word.text);
      }
    }
    newcomers.forEach((text) => seen.current.add(text));
    previousCounts.current = new Map(words.map((word) => [word.text, word.value]));
    if (newcomers.length) {
      setEnteringState((current) => {
        const next = new Set(current);
        newcomers.forEach((text) => next.add(text));
        return next;
      });
      const enterTimer = window.setTimeout(() => {
        enterTimers.current.delete(enterTimer);
        setEnteringState((current) => {
          const next = new Set(current);
          newcomers.forEach((text) => next.delete(text));
          return next;
        });
      }, WORD_CLOUD_ENTER_TIMEOUT_MS);
      enterTimers.current.add(enterTimer);
    }
    if (!nextPop.size) return;
    setPopping(nextPop);
    const popTimer = window.setTimeout(() => setPopping(new Set()), WORD_CLOUD_POP_TIMEOUT_MS);
    return () => window.clearTimeout(popTimer);
  }, [words]);

  if (!words.length) return null;
  return (
    <div className={`word-cloud-results${onTogglePin ? " is-interactive" : ""}`} aria-label={label}>
      <svg viewBox={`0 0 ${WORD_CLOUD_WIDTH} ${WORD_CLOUD_HEIGHT}`} role="img">
        <title>{label}</title>
        {/* d3-cloud lays out asynchronously. Keep the last completed layout
            visible until the current aggregate has finished calculating. */}
        <Wordcloud
          width={WORD_CLOUD_WIDTH}
          height={WORD_CLOUD_HEIGHT}
          words={words}
          padding={4}
          font={palette.font}
          fontSize={fontSize}
          fontWeight={fontWeight}
          rotate={rotate}
          spiral="archimedean"
          random={WORD_CLOUD_RANDOM}
        >
          {(cloudWords: WordCloudGlyph[]) => {
            const isCurrentCloudLayout = cloudWords.length > 0
              && cloudWords.every((word) => wordReferences.has(word));
            if (cloudWordsReference.current !== cloudWords) {
              cloudWordsReference.current = cloudWords;
              if (isCurrentCloudLayout) completedLayoutRevision.current = layoutRevision;
            }
            const renderWords = (positionedWords: PositionedWordCloudGlyph[]) => positionedWords.map((word) => {
              const text = word.text;
              const isPinned = pinnedSet.has(text);
              const isFloating = !isPinned && floatingTexts.has(text);
              return (
                <WordCloudWord
                  key={text}
                  colors={palette.colors}
                  entering={entering.has(text)}
                  floating={isFloating}
                  hot={isFloating && word.size >= maxSize * 0.72}
                  interactive={Boolean(onTogglePin)}
                  motionStyle={motionStyles.get(text) ?? {}}
                  onTogglePin={toggleWordPin}
                  pinLabel={pinLabel}
                  pinned={isPinned}
                  popping={popping.has(text)}
                  unpinLabel={unpinLabel}
                  word={word}
                />
              );
            });
            if (completedLayoutRevision.current !== layoutRevision) {
              return renderWords(completedLayout.current.filter((word) => visibleTexts.has(word.text)));
            }
            const cachedLayout = processedLayout.current;
            if (
              cachedLayout
              && cachedLayout.cloudWords === cloudWords
              && cachedLayout.revision === layoutRevision
              && cachedLayout.pinnedSignature === pinnedSignature
            ) {
              return renderWords(cachedLayout.words);
            }
            const laidOutWords = cloudWords.map((word): PositionedWordCloudGlyph => ({
              ...word,
              text: word.text ?? "",
              rotate: word.rotate ?? 0,
              size: word.size ?? 24,
              x: word.x ?? 0,
              y: word.y ?? 0,
            }));
            const laidOutTexts = new Set(laidOutWords.map((word) => word.text));
            const missingWords = words
              .filter((word) => !laidOutTexts.has(word.text))
              .map((word): PositionedWordCloudGlyph => ({
                ...word,
                font: palette.font,
                rotate: rotate(word),
                size: fontSize(word),
                weight: fontWeight(word),
                x: 0,
                y: 0,
              }));
            const restoredWords = restoreMissingWordCloudWords(laidOutWords, missingWords).map((word): PositionedWordCloudGlyph => ({
              ...word,
              text: word.text ?? "",
              rotate: word.rotate ?? 0,
              size: word.size ?? 24,
              x: word.x ?? 0,
              y: word.y ?? 0,
            }));
            const restoredTexts = new Set(restoredWords.map((word) => word.text));
            for (const text of pinnedPositions.current.keys()) {
              if (!pinnedSet.has(text) || !restoredTexts.has(text)) pinnedPositions.current.delete(text);
            }
            const pinnedWords = restoredWords
              .filter((word) => pinnedSet.has(word.text))
              .map((word) => {
                const saved = pinnedPositions.current.get(word.text);
                if (!saved) {
                  pinnedPositions.current.set(word.text, {
                    x: word.x,
                    y: word.y,
                    rotate: word.rotate,
                  });
                  return word;
                }
                return { ...word, ...saved };
              });
            const positionedWords = reflowWordCloudAroundPinned(restoredWords, pinnedWords);
            completedLayout.current = positionedWords;
            processedLayout.current = {
              cloudWords,
              pinnedSignature,
              revision: layoutRevision,
              words: positionedWords,
            };
            return renderWords(positionedWords);
          }}
        </Wordcloud>
      </svg>
    </div>
  );
}

export function wordCloudLayoutSignature(entries: Array<{ text: string; count: number }>) {
  return JSON.stringify(entries.slice(0, 80).map(({ text, count }) => [text, count]));
}
