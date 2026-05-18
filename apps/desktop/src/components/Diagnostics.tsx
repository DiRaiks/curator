import type { Diagnostic } from "../types";

interface DiagnosticsProps {
  diagnostics: Diagnostic[];
}

export function Diagnostics({ diagnostics }: DiagnosticsProps) {
  if (diagnostics.length === 0) {
    return <p className="empty">No diagnostics. Vault looks clean.</p>;
  }
  return (
    <ul className="list">
      {diagnostics.map((d, i) => (
        <li key={i} className={"list__item diag diag--" + d.level}>
          <div className="list__primary">
            <span className={"tag tag--" + d.level}>{d.level}</span>
            <span>{d.message}</span>
          </div>
          {d.path && <div className="list__secondary">{d.path}</div>}
        </li>
      ))}
    </ul>
  );
}
