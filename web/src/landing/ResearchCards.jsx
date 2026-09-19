const STATS = [
  { label: "APTOS Validation QWK", value: "0.93", note: "Quadratic weighted kappa" },
  { label: "Kaggle Private QWK", value: "0.92", note: "Held-out private split" },
  { label: "Proposed XAI Method", value: "CCEM", note: "Consensus-Calibrated Explanation Map" },
];

export default function ResearchCards() {
  return (
    <section className="section section-alt">
      <div className="container">
        <span className="eyebrow">Research</span>
        <h2 className="h2">Grounded in Published Experiments</h2>
        <p className="section-lead">
          Reported figures come from our internal research evaluation on public
          benchmark datasets. They describe model performance in a research
          setting and are not clinical validation results.
        </p>

        <div className="stat-row">
          {STATS.map((stat) => (
            <div className="card stat-card" key={stat.label}>
              <span className="stat-label">{stat.label}</span>
              <strong className="stat-value">{stat.value}</strong>
              <span className="stat-note">{stat.note}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}