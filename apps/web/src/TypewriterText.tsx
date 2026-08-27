import { useEffect, useState } from "react";

export function TypewriterText({ text }: { text: string }) {
  const characters = [...text];
  const [count, setCount] = useState(0);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (reducedMotion || characters.length === 0) {
      setCount(characters.length);
      return;
    }
    setCount(0);
    const step = Math.max(8, Math.min(36, 1400 / Math.max(1, characters.length)));
    const timer = window.setInterval(() => {
      setCount((current) => {
        if (current >= characters.length) {
          window.clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, step);
    return () => window.clearInterval(timer);
  }, [text, reducedMotion, characters.length]);

  if (reducedMotion) return <>{text}</>;
  return (
    <>
      <span>{characters.slice(0, count).join("")}</span>
      <span className="typewriter-cursor" aria-hidden="true">█</span>
    </>
  );
}

export function ProjectionHeading({ theme, text }: { theme: string; text: string }) {
  if (theme === "terminal") return <TypewriterText key={text} text={text} />;
  return <>{text}</>;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
