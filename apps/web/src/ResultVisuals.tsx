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

function WordCloudResult({ entries, label }: { entries: Array<{ text: string; count: number }>; label: string }) {
  const words = entries.slice(0, 80).map((entry) => ({ text: entry.text, value: entry.count }));
  if (!words.length) return null;
  const minimum = Math.min(...words.map((word) => word.value));
  const maximum = Math.max(...words.map((word) => word.value));
  const size = (value: number) => 24 + ((value - minimum) / Math.max(1, maximum - minimum)) * 64;
  const colors = ["#f8f6ef", "#f2ce6e", "#8dd5ae", "#f0a89f", "#d9c2f0"];
  return (
    <div className="word-cloud-results" aria-label={label}>
      <svg viewBox="0 0 720 400" role="img">
        <Wordcloud
          width={720}
          height={400}
          words={words}
          padding={4}
          font='Inter, ui-sans-serif, system-ui, sans-serif'
          fontSize={(word) => size(word.value)}
          fontWeight={800}
          rotate={(_, index) => index % 7 === 0 ? -12 : index % 11 === 0 ? 12 : 0}
          spiral="archimedean"
          random={() => 0.5}
        >
          {(cloudWords) => cloudWords.map((word, index) => (
            <text
              key={`${word.text}-${index}`}
              x={word.x}
              y={word.y}
              fill={colors[index % colors.length]}
              fontFamily={word.font}
              fontSize={word.size}
              fontWeight={word.weight}
              textAnchor="middle"
              transform={`rotate(${word.rotate ?? 0}, ${word.x ?? 0}, ${word.y ?? 0})`}
            >
              {word.text}
            </text>
          ))}
        </Wordcloud>
      </svg>
    </div>
  );
}
