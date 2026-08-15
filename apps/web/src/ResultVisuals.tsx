import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { Wordcloud } from "@visx/wordcloud";

import type { Aggregate, Question } from "./types";

type Translate = (key: any, params?: Readonly<Record<string, string | number>>) => string;

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

export function AggregateBars({ t, aggregate }: { t: Translate; aggregate: Aggregate }) {
  if (aggregate.interaction_type === "understanding") {
    const segments = [
      ["green", aggregate.green_percent ?? aggregate.understood_percent ?? 0],
      ["yellow", aggregate.yellow_percent ?? 0],
      ["red", aggregate.red_percent ?? 0],
    ] as const;
    return <div className="understanding-result">{segments.map(([name, percent]) => <div key={name} className={name} style={{ width: `${percent}%` }}><span>{Math.round(percent)}%</span></div>)}</div>;
  }
  if (aggregate.interaction_type === "word_cloud") {
    return <WordCloudResult label={t("interaction.wordCloud")} entries={aggregate.entries ?? []} />;
  }
  return <div className="result-options">{aggregate.options?.map((option) => {
    const percent = aggregate.total_responses ? Math.round(option.count * 100 / aggregate.total_responses) : 0;
    return <div key={option.option_id}><span>{option.label}</span><div className="result-track"><i style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>;
  })}</div>;
}

export function CueResultVisuals({ t, interactions, questions }: {
  t: Translate;
  interactions: Array<{
    id: string;
    prompt: string;
    interaction_type: string;
    aggregate?: Aggregate | null;
  }>;
  questions: Question[];
}) {
  const multi = interactions.length > 1;
  return (
    <div className="projection-visuals">
      {interactions.map((interaction) => (
        <article className="projection-interaction" key={interaction.id}>
          {multi && <h2>{interaction.prompt}</h2>}
          {interaction.interaction_type === "qa" ? (
            questions.length
              ? <div className="projection-questions"><QuestionList t={t} questions={questions} busy /></div>
              : <span className="projection-empty">{t("qa.empty")}</span>
          ) : interaction.aggregate ? (
            <AggregateBars t={t} aggregate={interaction.aggregate} />
          ) : (
            <span className="projection-empty">{t("projection.noResults")}</span>
          )}
        </article>
      ))}
    </div>
  );
}

const WORD_CLOUD_COLORS = ["#f8f6ef", "#f2ce6e", "#8dd5ae", "#f0a89f", "#d9c2f0", "#7ed0e6", "#ffc09a"];
const WORD_CLOUD_ANGLES = [0, 0, 0, -7, 7, -13, 13, -20, 20];
const WORD_CLOUD_RANDOM = () => 0.5;
const WORD_CLOUD_WIDTH = 720;
const WORD_CLOUD_HEIGHT = 400;
const WORD_CLOUD_SINGLE_SIZE = WORD_CLOUD_HEIGHT / 3;

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

function wordTone(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function wordCloudRotate(word: { text: string }): number {
  return WORD_CLOUD_ANGLES[wordTone(word.text) % WORD_CLOUD_ANGLES.length];
}

function wordMotionStyle(text: string): CSSProperties {
  const tone = wordTone(text);
  return {
    "--drift-x": `${4 + (tone % 5)}px`,
    "--drift-y": `${5 + ((tone >>> 4) % 6)}px`,
    "--enter-delay": `${(tone % 9) * 0.045}s`,
    "--float-delay": `${0.55 + ((tone >>> 8) % 18) / 10}s`,
    "--float-duration": `${6 + (tone % 5)}s`,
  } as CSSProperties;
}

function WordCloudResult({ entries, label }: { entries: Array<{ text: string; count: number }>; label: string }) {
  const wordSignature = entries.slice(0, 80).map((entry) => `${entry.text}\t${entry.count}`).join("\n");
  const words = useMemo(
    () => entries.slice(0, 80).map((entry) => ({ text: entry.text, value: entry.count })),
    // Only rebuild when visible text/count pairs change, not when the parent sends a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wordSignature],
  );
  const seen = useRef(new Set<string>());
  const previousCounts = useRef(new Map<string, number>());
  const enterTimers = useRef<number[]>([]);
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
    <div className="word-cloud-results" aria-label={label}>
      <svg viewBox={`0 0 ${WORD_CLOUD_WIDTH} ${WORD_CLOUD_HEIGHT}`} role="img">
        <Wordcloud
          width={WORD_CLOUD_WIDTH}
          height={WORD_CLOUD_HEIGHT}
          words={words}
          padding={8}
          font="Inter, ui-sans-serif, system-ui, sans-serif"
          fontSize={fontSize}
          fontWeight={fontWeight}
          rotate={wordCloudRotate}
          spiral="archimedean"
          random={WORD_CLOUD_RANDOM}
        >
          {(cloudWords: WordCloudGlyph[]) => cloudWords.map((word) => {
            const text = word.text ?? "";
            const hot = (word.size ?? 0) >= maxSize * 0.72;
            return (
              <g key={text} transform={`translate(${word.x ?? 0}, ${word.y ?? 0}) rotate(${word.rotate ?? 0})`}>
                <g
                  className={`word-cloud-enter${entering.has(text) ? " is-entering" : ""}${popping.has(text) ? " is-popping" : ""}${hot ? " is-hot" : ""}`}
                  style={wordMotionStyle(text)}
                >
                  <g className="word-cloud-float">
                    <text
                      fill={WORD_CLOUD_COLORS[wordTone(text) % WORD_CLOUD_COLORS.length]}
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
          })}
        </Wordcloud>
      </svg>
    </div>
  );
}
