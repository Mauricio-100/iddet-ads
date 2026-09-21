import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2, Zap } from 'lucide-react';
import { loginRequest, registerRequest, type StoredSession } from '@/lib/auth';

const inputClass =
  'mt-2 h-12 w-full rounded-lg border border-input bg-card px-3 text-base font-normal outline-none focus:border-[#91b44d]';

export function AuthScreen({ onAuthed, notice }: { onAuthed: (session: StoredSession) => void; notice?: string | null }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Le serveur IDDET (Render) peut mettre du temps à se réveiller : on prévient l'utilisateur.
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const session =
        mode === 'login'
          ? await loginRequest(username.trim(), password)
          : await registerRequest(username.trim(), password, email.trim());
      onAuthed(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue. Réessaie.');
      setPending(false);
    }
  };

  const switchMode = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="noise min-h-[100dvh] bg-background">
      <div className="mx-auto flex min-h-[100dvh] max-w-md items-center justify-center px-5 py-10">
        <section className="w-full rounded-3xl border border-card-border bg-card p-6 shadow-[var(--shadow-md)] sm:p-8" data-testid="screen-auth">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-[#dcecb4] text-[#273744]"><Zap className="h-5 w-5 fill-current" /></span>
            <div>
              <p className="font-display text-xl font-bold tracking-tight">IDDET Ads</p>
              <p className="font-mono-ui text-[10px] uppercase tracking-[.16em] text-muted-foreground">espace annonceur</p>
            </div>
          </div>

          <div className="mt-7 grid grid-cols-2 rounded-xl bg-secondary p-1 text-sm font-bold" role="tablist">
            {([['login', 'Connexion'], ['register', 'Créer un compte']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                onClick={() => switchMode(value)}
                className={mode === value ? 'rounded-lg bg-card py-2.5 shadow-sm' : 'rounded-lg py-2.5 text-muted-foreground'}
                data-testid={`tab-${value}`}
              >
                {label}
              </button>
            ))}
          </div>

          <h1 className="mt-6 font-display text-2xl font-bold tracking-[-.03em]">
            {mode === 'login' ? 'Content de te revoir.' : 'Rejoins IDDET.'}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === 'login' ? 'Connecte-toi avec ton compte IDDET.' : 'Ton compte IDDET te sert aussi à publier tes annonces.'}
          </p>

          {notice && <p className="mt-4 rounded-lg bg-[#fbf3d7] px-3 py-2 text-sm font-semibold text-[#806b1b]" data-testid="status-auth-notice">{notice}</p>}

          <form onSubmit={submit} className="mt-5 space-y-4">
            <label className="block text-xs font-bold">
              Nom d'utilisateur
              <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="next" className={inputClass} data-testid="input-auth-username" />
            </label>
            {mode === 'register' && (
              <label className="block text-xs font-bold">
                E-mail <span className="font-normal text-muted-foreground">(facultatif)</span>
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" className={inputClass} data-testid="input-auth-email" />
              </label>
            )}
            <label className="block text-xs font-bold">
              Mot de passe
              <div className="relative">
                <input value={password} onChange={e => setPassword(e.target.value)} type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} enterKeyHint="go" className={`${inputClass} pr-12`} data-testid="input-auth-password" />
                <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'} className="absolute right-1 top-3.5 rounded-lg p-2.5 text-muted-foreground">
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {mode === 'register' && <span className="mt-1 block font-normal text-muted-foreground">6 caractères minimum.</span>}
            </label>

            {error && <p className="text-sm font-semibold text-[#9d3b2d]" role="alert" data-testid="status-auth-error">{error}</p>}

            <button
              type="submit"
              disabled={pending || !username.trim() || !password}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50"
              data-testid="button-auth-submit"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
            </button>
            {slow && <p className="text-center text-xs text-muted-foreground">Le serveur IDDET se réveille, ça peut prendre jusqu'à une minute…</p>}
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === 'login' ? "Pas encore de compte ? " : 'Déjà un compte ? '}
            <button type="button" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')} className="font-bold text-foreground underline underline-offset-4">
              {mode === 'login' ? 'Créer un compte' : 'Se connecter'}
            </button>
          </p>
        </section>
      </div>
    </div>
  );
}
