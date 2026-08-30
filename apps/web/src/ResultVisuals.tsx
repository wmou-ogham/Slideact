import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Wordcloud } from "@visx/wordcloud";

import type { Translate } from "./i18n";
import { WORD_CLOUD_THEME } from "./projectionTheme";
import { ProjectionHeading } from "./TypewriterText";
import type { Aggregate, Question } from "./types";
import { useProjectionThemeValue } from "./useProjectionTheme";

export function QuestionList({ t, questions, busy, onVote }: {
  t: Translate;
  questions: Question[];
  busy: boolean;
  onVote?: (questionId: string) => Promise<void>;
}) {
  if (!questions.length) return <p className="qa-empty">{t("qa.empty")}</p>;
  return (
    <div className="question-list">
      {questions.map((question) => (
        <article className={`question-card question-${question.status}`} key={question.id}>
          <div>
            {question.status === "pinned" && <span>{t("qa.pinned")}</span>}
            <p>{question.body}</p>
            {question.status === "answered" && <small>{t("qa.answered")}</small>}
          </div>
          <button
            className={question.voted_by_me ? "question-vote selected" : "question-vote"}
            disabled={busy || !onVote}
            onClick={() => onVote?.(question.id)}
            aria-label={t("qa.votes", { count: question.votes })}
          >
            <b>▲</b>{question.votes}
          </button>
        </article>
      ))}
    </div>
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
      {interactions.map((interaction) => (
        <article className="projection-interaction" key={interaction.id}>
          {multi && <h2><ProjectionHeading theme={theme} text={interaction.prompt} /></h2>}
          {interaction.interaction_type === "qa" ? (
            interaction.results_visible !== false && questions.length
              ? <div className="projection-questions"><QuestionList t={t} questions={questions} busy /></div>
              : <span className="projection-empty">{t(interaction.results_visible !== false ? "qa.empty" : "projection.noResults")}</span>
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
        </article>
      ))}
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

export function wordCloudSizeRange(wordCount: number): { minSize: number; maxSize: number } {
  const count = Math.max(1, wordCount);
  const maxSize = WORD_CLOUD_SINGLE_SIZE / count ** 0.28;
  const minSize = count === 1 ? maxSize : Math.max(18, maxSize * 0.32);
  return { minSize, maxSize };
}

export function wordCloudFontSize(
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

type WordCloudGlyph = {
  text?: string;
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
  return {
    "--drift-x": `${4 + (tone % 5)}px`,
    "--drift-y": `${5 + ((tone >>> 4) % 6)}px`,
    "--enter-delay": `${(tone % 9) * 0.045}s`,
    "--float-delay": `${0.55 + ((tone >>> 8) % 18) / 10}s`,
    "--float-duration": `${4.1 + (tone % 5) * 0.15}s`,
  } as CSSProperties;
}

type PinnedLayout = { x: number; y: number; rotate: number };

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

/** Keeps pinned words fixed and relocates only words that would cover them. */
export function avoidPinnedWordCollisions<T extends PositionedWordCloudGlyph>(
  words: T[],
  pinned: ReadonlySet<string>,
  width = WORD_CLOUD_WIDTH,
  height = WORD_CLOUD_HEIGHT,
): T[] {
  const pinnedWords = words.filter((word) => pinned.has(word.text));
  if (!pinnedWords.length) return words;
  const displaced = new Set(words
    .filter((word) => !pinned.has(word.text)
      && pinnedWords.some((fixed) => wordCloudWordsOverlap(word, fixed)))
    .map((word) => word.text));
  if (!displaced.size) return words;

  const occupied = words.filter((word) => !displaced.has(word.text));
  const relocated = new Map<string, T>();
  const pending = words
    .filter((word) => displaced.has(word.text))
    .sort((left, right) => right.size - left.size);
  for (const word of pending) {
    const next = findAvailableWordPosition(word, occupied, width, height) as T | null;
    if (!next) continue;
    relocated.set(word.text, next);
    occupied.push(next);
  }
  return words.flatMap((word) => {
    if (!displaced.has(word.text)) return [word];
    const next = relocated.get(word.text);
    return next ? [next] : [];
  });
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
    while (size >= 12 && !next) {
      const candidate = { ...word, size } as T;
      if (wordFitsCanvas(candidate, width, height)
        && occupied.every((current) => !wordCloudWordsOverlap(candidate, current))) {
        next = candidate;
      } else {
        next = findAvailableWordPosition(candidate, occupied, width, height) as T | null;
      }
      size = Math.floor(size * 0.85);
    }
    if (!next) continue;
    occupied.push(next);
    restored.push(next);
  }
  return [...placed, ...restored];
}

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
  const enterTimers = useRef<number[]>([]);
  const pinnedLayout = useRef(new Map<string, PinnedLayout>());
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const [enteringState, setEnteringState] = useState<ReadonlySet<string>>(new Set());
  const [popping, setPopping] = useState<ReadonlySet<string>>(new Set());
  const entering = new Set(enteringState);
  for (const word of words) {
    if (!seen.current.has(word.text)) entering.add(word.text);
  }
  const minimum = words.length ? Math.min(...words.map((word) => word.value)) : 0;
  const maximum = words.length ? Math.max(...words.map((word) => word.value)) : 1;
  const { maxSize } = wordCloudSizeRange(words.length);
  const fontSize = useMemo(
    () => (word: { text: string; value: number }) => wordCloudFontSize(word, minimum, maximum, words.length),
    [minimum, maximum, words.length],
  );
  const fontWeight = useMemo(
    () => (word: { value: number }) => (word.value >= maximum * 0.55 ? 800 : 650),
    [maximum],
  );

  useEffect(() => () => {
    enterTimers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!words.length) {
      seen.current.clear();
      previousCounts.current.clear();
      pinnedLayout.current.clear();
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
      enterTimers.current.push(window.setTimeout(() => {
        setEnteringState((current) => {
          const next = new Set(current);
          newcomers.forEach((text) => next.delete(text));
          return next;
        });
      }, 1100));
    }
    if (!nextPop.size) return;
    setPopping(nextPop);
    const popTimer = window.setTimeout(() => setPopping(new Set()), 520);
    return () => window.clearTimeout(popTimer);
  }, [words]);

  if (!words.length) return null;
  return (
    <div className={`word-cloud-results${onTogglePin ? " is-interactive" : ""}`} aria-label={label}>
      <svg viewBox={`0 0 ${WORD_CLOUD_WIDTH} ${WORD_CLOUD_HEIGHT}`} role="img">
        {/* d3-cloud lays out asynchronously. A revision key prevents an older
            layout from replacing a newer aggregate after rapid submissions. */}
        <Wordcloud
          key={`${theme}\n${wordSignature}`}
          width={WORD_CLOUD_WIDTH}
          height={WORD_CLOUD_HEIGHT}
          words={words}
          padding={8}
          font={palette.font}
          fontSize={fontSize}
          fontWeight={fontWeight}
          rotate={rotate}
          spiral="archimedean"
          random={WORD_CLOUD_RANDOM}
        >
          {(cloudWords: WordCloudGlyph[]) => {
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
            const completeWords = restoreMissingWordCloudWords(laidOutWords, missingWords);
            const positionedWords = completeWords.map((word): PositionedWordCloudGlyph => {
              const text = word.text ?? "";
              const positioned = {
                ...word,
                text,
                rotate: word.rotate ?? 0,
                size: word.size ?? 24,
                x: word.x ?? 0,
                y: word.y ?? 0,
              };
              if (!pinnedSet.has(text)) {
                pinnedLayout.current.delete(text);
                return positioned;
              }
              const saved = pinnedLayout.current.get(text);
              if (saved) return { ...positioned, ...saved };
              pinnedLayout.current.set(text, {
                x: positioned.x,
                y: positioned.y,
                rotate: positioned.rotate,
              });
              return positioned;
            });
            const visibleWords = avoidPinnedWordCollisions(positionedWords, pinnedSet);
            return visibleWords.map((word) => {
              const text = word.text;
              const isPinned = pinnedSet.has(text);
              const size = word.size;
              const boxWidth = estimateWordWidth(text, size) + Math.max(16, size * 0.35);
              const boxHeight = size * 1.22;
              const hot = size >= maxSize * 0.72;
              return (
                <g
                  key={text}
                  className={onTogglePin ? "word-cloud-hit" : undefined}
                  transform={`translate(${word.x}, ${word.y}) rotate(${word.rotate})`}
                  onClick={onTogglePin ? (event) => {
                    onTogglePin(text, !isPinned);
                    if (event.detail) event.currentTarget.blur();
                  } : undefined}
                  role={onTogglePin ? "button" : undefined}
                  tabIndex={onTogglePin ? 0 : undefined}
                  aria-pressed={onTogglePin ? isPinned : undefined}
                  aria-label={onTogglePin ? (isPinned ? unpinLabel : pinLabel) : undefined}
                  onKeyDown={onTogglePin ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onTogglePin(text, !isPinned);
                    }
                  } : undefined}
                >
                  {isPinned && (
                    <rect
                      className="word-cloud-pin-box"
                      x={-boxWidth / 2}
                      y={-size * 0.88}
                      width={boxWidth}
                      height={boxHeight}
                      rx={Math.max(6, size * 0.12)}
                    />
                  )}
                  <g
                    className={`word-cloud-enter${entering.has(text) ? " is-entering" : ""}${popping.has(text) && !isPinned ? " is-popping" : ""}${hot ? " is-hot" : ""}`}
                    style={isPinned ? undefined : wordMotionStyle(text)}
                  >
                    <g className={isPinned ? undefined : "word-cloud-float"}>
                      <text
                        fill={palette.colors[wordTone(text) % palette.colors.length]}
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
              );
            });
          }}
        </Wordcloud>
      </svg>
    </div>
  );
}

export function wordCloudLayoutSignature(entries: Array<{ text: string; count: number }>) {
  return JSON.stringify(entries.slice(0, 80).map(({ text, count }) => [text, count]));
}
