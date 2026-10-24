import { useEffect, useState } from "react";
const headlines = [["Quote both sides.", "Keep trades moving."], ["Give the next trade", "a price."]] as const;
export function HeroHeading() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer = 0;
    const update = () => { window.clearInterval(timer); if (!preference.matches) timer = window.setInterval(() => setActive(value => (value + 1) % headlines.length), 8_000); };
    update(); preference.addEventListener("change", update);
    return () => { window.clearInterval(timer); preference.removeEventListener("change", update); };
  }, []);
  return <h1 className="hero-heading"><span className="sr-only">Quote both sides. Keep trades moving.</span><span className="hero-heading-window" aria-hidden="true">{headlines.map(([first, second], index) => <span className={`hero-heading-slide${index === active ? " is-active" : ""}`} key={first}>{first}<br/><em>{second}</em></span>)}</span></h1>;
}
