interface WelcomeProps {
  onOpenVault: () => void;
  onOpenDemo: () => void;
  error: string | null;
  loading: boolean;
}

export function Welcome({ onOpenVault, onOpenDemo, error, loading }: WelcomeProps) {
  return (
    <div className="welcome">
      <div className="welcome__card">
        <h1 className="welcome__title">Vault Workflow IDE</h1>
        <p className="welcome__subtitle">
          A workflow tool for Markdown vaults. Open a vault folder to get started.
        </p>
        <div className="welcome__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onOpenVault}
            disabled={loading}
          >
            Open Vault…
          </button>
          <div className="welcome__demo">
            <button
              type="button"
              className="btn"
              onClick={onOpenDemo}
              disabled={loading}
            >
              Open Demo Vault
            </button>
            <p className="welcome__demo-hint">
              Sanitized fixture bundled with the repo — for onboarding and
              tests only.
            </p>
          </div>
        </div>
        {loading && <p className="welcome__hint">Scanning…</p>}
        {error && <p className="welcome__error">{error}</p>}
      </div>
    </div>
  );
}
