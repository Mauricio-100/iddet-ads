import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity as ActivityIcon, ArrowRight, BadgeCheck, BarChart3, Bell, Check,
  CheckCircle2, ChevronRight, CircleAlert, ClipboardList,
  Globe2, Hash, LayoutDashboard, Link2, Loader2, LogOut, Menu, Package, Pencil, Plus,
  RefreshCw, Send, Settings2, ShoppingBag, Sparkles, Store, Users, X, Zap,
} from 'lucide-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  getGetOverviewQueryKey, getGetShopifyConnectionQueryKey, getListAdDraftsQueryKey,
  getListIddetAccountsQueryKey, getListIddetCommunitiesQueryKey, getListProductsQueryKey,
  ApiError, customFetch, setAuthTokenGetter, useConnectIddetAccount, useCreateAdDraft, useGetOverview,
  useGetShopifyConnection, useListAdDrafts, useListIddetAccounts, useListIddetCommunities,
  useListProducts, usePublishAdDraft, useSyncShopifyProducts,
  type Activity, type AdDraft, type IddetAccount, type IddetCommunity, type Product,
} from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { AuthScreen } from '@/components/auth-screen';
import {
  AuthContext, SESSION_EXPIRED_EVENT, apiErrorMessage, clearSession, readSession, saveSession, useAuth,
  type StoredSession,
} from '@/lib/auth';

// Une réponse 401 hors Shopify = session IDDET expirée : on renvoie l'utilisateur à l'écran de connexion.
function handleAuthError(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && !window.shopify?.idToken) {
    clearSession();
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAuthError }),
  mutationCache: new MutationCache({ onError: handleAuthError }),
  defaultOptions: {
    queries: { retry: (failureCount, error) => !(error instanceof ApiError && error.status === 401) && failureCount < 2 },
  },
});

declare global {
  interface Window {
    shopify?: {
      idToken?: () => Promise<string>;
    };
  }
}

// Dans Shopify, App Bridge fournit un jeton de session à courte durée de vie.
// Hors Shopify, on utilise la session créée à la connexion IDDET.
setAuthTokenGetter(async () => {
  const idToken = window.shopify?.idToken;
  if (idToken) return idToken();
  return readSession()?.token ?? null;
});

const navItems = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/products', label: 'Products', icon: Package },
  { href: '/drafts', label: 'Ads & drafts', icon: ClipboardList },
  { href: '/connections', label: 'Connections', icon: Link2 },
];

function cx(...classes: Array<string | false | undefined>) { return classes.filter(Boolean).join(' '); }

function formatMoney(value: number, currency: string) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}

function formatDate(value?: string | null) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function relativeDate(value?: string | null) {
  if (!value) return 'Recently';
  const diff = Date.now() - new Date(value).getTime();
  const hours = Math.max(1, Math.floor(diff / 3600000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function Avatar({ name, src, size = 'md' }: { name: string; src?: string | null; size?: 'sm' | 'md' }) {
  return src ? <img src={src} alt="" className={cx('rounded-full object-cover ring-2 ring-card', size === 'sm' ? 'h-7 w-7' : 'h-9 w-9')} /> :
    <span className={cx('grid place-items-center rounded-full bg-[#dcecb4] font-display font-bold text-[#293747] ring-2 ring-card', size === 'sm' ? 'h-7 w-7 text-[10px]' : 'h-9 w-9 text-xs')}>{name.slice(0, 2).toUpperCase()}</span>;
}

function StatusPill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'lime' | 'coral' | 'ink' | 'amber' }) {
  const tones = {
    neutral: 'bg-secondary text-muted-foreground',
    lime: 'bg-[#e3f1bd] text-[#415b1a]',
    coral: 'bg-[#f9ded7] text-[#9d3b2d]',
    ink: 'bg-primary text-primary-foreground',
    amber: 'bg-[#f5e7ba] text-[#705c17]',
  };
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono-ui text-[10px] font-medium uppercase tracking-[.08em]', tones[tone])}>{children}</span>;
}

function Button({ children, className, variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'coral' }) {
  const variants = {
    primary: 'bg-primary text-primary-foreground hover:-translate-y-0.5 hover:shadow-md',
    secondary: 'bg-accent text-accent-foreground hover:-translate-y-0.5 hover:shadow-md',
    ghost: 'bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
    coral: 'bg-[#e96756] text-white hover:-translate-y-0.5 hover:shadow-md',
  };
  return <button {...props} className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)}>{children}</button>;
}

function LoadingRows({ count = 3 }: { count?: number }) {
  return <div className="space-y-3" data-testid="loading-skeleton">
    {Array.from({ length: count }).map((_, index) => <div key={index} className="h-16 animate-pulse rounded-xl bg-secondary/70" />)}
  </div>;
}

function ErrorState({ message = 'We could not load this view.' }: { message?: string }) {
  return <div className="rounded-xl border border-[#e5b3a9] bg-[#fff4f1] p-5 text-sm text-[#9d3b2d]" data-testid="status-error">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-3"><CircleAlert className="mt-0.5 h-5 w-5 shrink-0" /><div><p className="font-bold">Something needs a second look.</p><p className="mt-1">{message}</p></div></div><Button variant="ghost" className="self-start px-2.5 py-1.5 text-xs text-[#9d3b2d] hover:bg-[#f9ded7]" onClick={() => window.location.reload()} data-testid="button-retry">Try again</Button></div>
  </div>;
}

function EmptyState({ icon: Icon, title, detail, action }: { icon: typeof Package; title: string; detail: string; action?: ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-border bg-card/60 px-6 py-12 text-center" data-testid="empty-state">
    <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-muted-foreground"><Icon className="h-5 w-5" /></span>
    <h3 className="mt-4 font-display text-lg font-bold">{title}</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{detail}</p>{action && <div className="mt-5">{action}</div>}
  </div>;
}

function SplashState() {
  return <div className="noise grid min-h-[100dvh] place-items-center bg-background" data-testid="state-loading"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const connection = useGetShopifyConnection();
  const auth = useAuth();
  const isConnected = connection.data?.connected;
  return <div className="noise min-h-[100dvh] bg-background">
    <aside className={cx('fixed inset-y-0 left-0 z-40 flex w-[254px] flex-col border-r border-border bg-[#243342] px-4 py-5 text-[#f6f0e0] transition-transform md:translate-x-0', mobileOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="flex items-center justify-between px-3">
        <Link href="/" className="flex items-center gap-3" data-testid="link-brand">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#dcecb4] text-[#273744]"><Zap className="h-5 w-5 fill-current" /></span>
          <span><span className="block font-display text-lg font-bold tracking-tight">IDDET Ads</span><span className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#aab5af]">merchant workspace</span></span>
        </Link>
        <button className="rounded-lg p-2 text-[#aab5af] hover:bg-white/10 md:hidden" onClick={() => setMobileOpen(false)} data-testid="button-close-menu"><X className="h-4 w-4" /></button>
      </div>
      <div className="mt-10 px-3 font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#87958f]">Workspace</div>
      <nav className="mt-3 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? location === '/' : location.startsWith(href);
          return <Link key={href} href={href} onClick={() => setMobileOpen(false)} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`} className={cx('group flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold', active ? 'bg-[#dcecb4] text-[#263847]' : 'text-[#c8d0ca] hover:bg-white/10 hover:text-white')}>
            <Icon className={cx('h-[17px] w-[17px]', active ? 'text-[#516c20]' : 'text-[#aab5af]')} /><span>{label}</span>{active && <ChevronRight className="ml-auto h-4 w-4" />}
          </Link>;
        })}
      </nav>
      <div className="mt-auto">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center gap-2 text-xs font-bold"><span className={cx('h-2 w-2 rounded-full', isConnected ? 'bg-[#dcecb4]' : 'bg-[#e96756]')} />{auth.mode === 'iddet' ? 'Compte IDDET' : 'Store connection'}</div>
          <p className="mt-2 truncate font-mono-ui text-[11px] text-[#aab5af]">{connection.data?.storeName ?? 'No store connected'}</p>
          <Link href="/connections" className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-[#dcecb4]" data-testid="link-sidebar-connection">Manage connection <ArrowRight className="h-3 w-3" /></Link>
        </div>
         <div className="mt-5 flex items-center gap-3 border-t border-white/10 px-3 pt-5"><Avatar name={auth.mode === 'iddet' ? (auth.user?.username ?? 'IDDET') : (connection.data?.storeName ?? 'Shop')} src={auth.mode === 'iddet' ? auth.user?.avatarUrl : undefined} /><div className="min-w-0"><p className="truncate text-xs font-bold">{auth.mode === 'iddet' ? `@${auth.user?.username ?? ''}` : (connection.data?.storeName ?? 'Shopify shop')}</p><p className="truncate font-mono-ui text-[10px] text-[#aab5af]">{auth.mode === 'iddet' ? 'Espace IDDET' : (connection.data?.shopifyUserName ?? 'Embedded operator')}</p></div>{auth.mode === 'iddet' ? <button onClick={auth.logout} aria-label="Se déconnecter" className="ml-auto rounded-lg p-2 text-[#c8d0ca] hover:bg-white/10 hover:text-white" data-testid="button-logout"><LogOut className="h-4 w-4" /></button> : <Settings2 className="ml-auto h-4 w-4 shrink-0 text-[#87958f]" />}</div>
      </div>
    </aside>
    {mobileOpen && <button className="fixed inset-0 z-30 bg-[#243342]/40 md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation" data-testid="button-overlay-close" />}
    <main className="min-h-[100dvh] md:pl-[254px]">
      <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-border bg-background/90 px-5 backdrop-blur md:px-10">
        <button className="rounded-lg p-2 hover:bg-secondary md:hidden" onClick={() => setMobileOpen(true)} data-testid="button-open-menu"><Menu className="h-5 w-5" /></button>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"><span className="h-2 w-2 rounded-full bg-[#b8d87c]" />Connected publishing workspace</div>
        <div className="ml-auto flex items-center gap-3"><button className="relative rounded-lg p-2 text-muted-foreground hover:bg-secondary" data-testid="button-notifications"><Bell className="h-[18px] w-[18px]" /><span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#e96756]" /></button><div className="hidden h-5 w-px bg-border sm:block" /><span className="font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground">Live workspace</span></div>
      </header>
      <div className="mx-auto max-w-[1440px] px-5 py-7 md:px-10 md:py-10">{children}</div>
    </main>
  </div>;
}

function PageHeader({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.2em] text-[#71833c]" data-testid="text-page-eyebrow">{eyebrow}</p><h1 className="mt-2 font-display text-3xl font-bold tracking-[-.04em] text-foreground md:text-[42px]" data-testid="text-page-title">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground" data-testid="text-page-detail">{detail}</p></div>{action}</div>;
}

function Metric({ label, value, note, icon: Icon, accent = false }: { label: string; value: string | number; note: string; icon: typeof Package; accent?: boolean }) {
  return <div className={cx('rounded-2xl border p-5 shadow-[var(--shadow-sm)]', accent ? 'border-[#b8d87c] bg-[#eaf4ce]' : 'border-card-border bg-card')} data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>
    <div className="flex items-center justify-between"><span className="font-mono-ui text-[10px] uppercase tracking-[.13em] text-muted-foreground">{label}</span><Icon className={cx('h-4 w-4', accent ? 'text-[#5c7828]' : 'text-muted-foreground')} /></div>
    <div className="mt-4 font-display text-3xl font-bold tracking-[-.04em]">{value}</div><p className="mt-1 text-xs text-muted-foreground">{note}</p>
  </div>;
}

function ActivityList({ items }: { items: Activity[] }) {
  if (!items.length) return <EmptyState icon={ActivityIcon} title="Your activity feed is quiet" detail="Sync a store or start an ad draft to see the publishing trail here." />;
  const iconFor = (type: Activity['type']) => type === 'publish' ? Send : type === 'draft' ? Pencil : type === 'connection' ? Link2 : Package;
  return <div className="space-y-1" data-testid="list-activity">{items.slice(0, 6).map(item => { const Icon = iconFor(item.type); return <div className="flex items-start gap-3 rounded-xl px-2 py-3 hover:bg-secondary/70" key={item.id} data-testid={`activity-${item.id}`}><span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"><Icon className="h-4 w-4" /></span><div className="min-w-0 flex-1"><p className="text-sm font-bold">{item.label}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{item.detail}</p></div><time className="shrink-0 font-mono-ui text-[10px] text-muted-foreground">{relativeDate(item.createdAt)}</time></div>; })}</div>;
}

function Overview() {
  const overview = useGetOverview();
  const drafts = useListAdDrafts();
  const data = overview.data;
  const latestDraft = drafts.data?.find(draft => draft.status === 'draft');
  if (overview.isLoading) return <LoadingRows count={5} />;
  if (overview.isError || !data) return <ErrorState message="Overview data is unavailable right now. Refresh the page and try again." />;
  return <div className="rise">
    <PageHeader eyebrow="Control room / overview" title={data.storeName ? `Good to see you, ${data.storeName}.` : 'Turn products into community signal.'} detail="A focused workspace for moving the right products from Shopify into IDDET communities." action={<Link href="/products" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground hover:-translate-y-0.5 hover:shadow-md" data-testid="link-overview-products"><Package className="h-4 w-4" />Browse catalog <ArrowRight className="h-4 w-4" /></Link>} />
    {data.storeStatus !== 'connected' && <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-[#d9c986] bg-[#fbf3d7] p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="banner-store-setup"><div className="flex items-start gap-3"><Store className="mt-0.5 h-5 w-5 text-[#806b1b]" /><div><p className="font-bold">Your Shopify store is one step away.</p><p className="mt-1 text-sm text-[#806b1b]">Connect your store to pull products into the publishing pipeline.</p></div></div><Link href="/connections" className="inline-flex items-center gap-2 self-start rounded-lg bg-[#243342] px-3.5 py-2.5 text-sm font-bold text-[#f6f0e0]" data-testid="link-connect-store">Set up Shopify <ArrowRight className="h-4 w-4" /></Link></div>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Catalog" value={data.productCount} note="Shopify products" icon={Package} /><Metric label="In review" value={data.draftCount} note="Ad drafts waiting" icon={Pencil} accent /><Metric label="Published" value={data.publishedCount} note="Community ads" icon={Send} /><Metric label="This week" value={data.publishedThisWeek} note="Ads published" icon={BarChart3} /><Metric label="Accounts" value={data.connectedAccountCount} note="IDDET identities" icon={Users} />
    </div>
    <div className="mt-8 grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
      <div className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-publishing-pipeline">
        <div className="flex items-start justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">The flow</p><h2 className="mt-1 font-display text-xl font-bold">Product to community</h2></div><span className="rounded-full bg-[#eaf4ce] px-3 py-1 font-mono-ui text-[10px] text-[#587126]">3 steps</span></div>
        <div className="mt-8 grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          {[['01', 'Choose', 'Pick a product from your connected catalog', Package], ['02', 'Shape', 'Give the ad a voice that feels native', Pencil], ['03', 'Publish', 'Send it to the right IDDET community', Send]].map(([number, label, detail, Icon]) => <div key={label as string} className="contents"><div className="rounded-xl border border-border bg-background p-4"><span className="font-mono-ui text-[10px] text-[#71833c]">{number as string}</span><Icon className="mt-4 h-5 w-5 text-primary" /><p className="mt-3 font-bold">{label as string}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail as string}</p></div>{label !== 'Publish' && <ArrowRight className="mx-auto hidden h-5 w-5 text-[#9eae76] md:block" />}</div>)}
        </div>
        <div className="mt-5 flex flex-col gap-3 rounded-xl bg-[#243342] p-4 text-[#f6f0e0] sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#b8d87c]">Next action</p><p className="mt-1 text-sm font-bold">{latestDraft ? `Review “${latestDraft.title}”` : 'Create your first community ad'}</p></div><Link href={latestDraft ? '/drafts' : '/products'} className="inline-flex items-center gap-2 text-sm font-bold text-[#dcecb4]" data-testid="link-next-action">Open workspace <ArrowRight className="h-4 w-4" /></Link></div>
      </div>
      <div className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-recent-activity"><div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">Signal</p><h2 className="mt-1 font-display text-xl font-bold">Recent activity</h2></div><ActivityIcon className="h-5 w-5 text-muted-foreground" /></div><div className="mt-4"><ActivityList items={data.activity ?? []} /></div></div>
    </div>
  </div>;
}

function ManualProductForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [imageUrl, setImageUrl] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = 'mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-base font-normal outline-none focus:border-[#91b44d]';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const amount = Number(price.replace(',', '.'));
    if (!title.trim() || !Number.isFinite(amount) || amount < 0) { setError('Renseigne un nom et un prix valide.'); return; }
    setPending(true);
    setError(null);
    try {
      await customFetch('/api/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim(), price: amount, currency: currency.trim() || 'EUR', imageUrl: imageUrl.trim() || undefined, productUrl: productUrl.trim() || undefined }),
      });
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err, "Le produit n'a pas pu être ajouté."));
      setPending(false);
    }
  };
  return <form onSubmit={submit} className="mb-5 rounded-2xl border border-[#b8d87c] bg-[#f5f9e9] p-5 md:p-6" data-testid="form-add-product">
    <p className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-[#71833c]">Nouveau produit</p>
    <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto_auto]">
      <label className="block text-xs font-bold">Nom du produit<input value={title} onChange={e => setTitle(e.target.value)} className={field} data-testid="input-product-title" /></label>
      <label className="block text-xs font-bold">Prix<input value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" placeholder="19,90" className={`${field} md:w-32`} data-testid="input-product-price" /></label>
      <label className="block text-xs font-bold">Devise<input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} maxLength={3} autoCapitalize="characters" className={`${field} md:w-24`} data-testid="input-product-currency" /></label>
    </div>
    <label className="mt-4 block text-xs font-bold">Description<textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} className="mt-2 w-full resize-none rounded-lg border border-input bg-card px-3 py-3 text-base font-normal leading-6 outline-none focus:border-[#91b44d]" data-testid="input-product-description" /></label>
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <label className="block text-xs font-bold">Lien du produit<input value={productUrl} onChange={e => setProductUrl(e.target.value)} type="url" inputMode="url" autoCapitalize="none" placeholder="https://…" className={field} data-testid="input-product-url" /></label>
      <label className="block text-xs font-bold">Image (adresse)<input value={imageUrl} onChange={e => setImageUrl(e.target.value)} type="url" inputMode="url" autoCapitalize="none" placeholder="https://…" className={field} data-testid="input-product-image" /></label>
    </div>
    {error && <p className="mt-4 text-sm font-semibold text-[#9d3b2d]" role="alert" data-testid="status-product-error">{error}</p>}
    <div className="mt-5 flex justify-end"><Button type="submit" disabled={pending || !title.trim() || !price.trim()} variant="secondary" data-testid="button-save-product">{pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Ajouter</Button></div>
  </form>;
}

function Products() {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const isIddet = auth.mode === 'iddet';
  const [adding, setAdding] = useState(false);
  const products = useListProducts();
  const sync = useSyncShopifyProducts();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => (products.data ?? []).filter(p => `${p.title} ${p.description}`.toLowerCase().includes(search.toLowerCase())), [products.data, search]);
  const handleSync = () => sync.mutate(undefined, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() }); } });
  const onProductAdded = () => { setAdding(false); queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() }); };
  if (products.isLoading) return <LoadingRows count={6} />;
  if (products.isError) return <ErrorState message={isIddet ? 'The catalog could not be loaded. Refresh the page and try again.' : 'The catalog could not be loaded. Check the Shopify connection, then retry.'} />;
  return <div className="rise"><PageHeader eyebrow={isIddet ? 'Catalog' : 'Catalog / Shopify'} title="Your product shelf." detail="Choose a product, shape the story, and send it into the IDDET publishing line." action={isIddet ? <Button onClick={() => setAdding(value => !value)} variant="secondary" data-testid="button-add-product">{adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{adding ? 'Fermer' : 'Ajouter un produit'}</Button> : <Button onClick={handleSync} disabled={sync.isPending} variant="secondary" data-testid="button-sync-products">{sync.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Sync catalog</Button>} />
    {isIddet && adding && <ManualProductForm onCreated={onProductAdded} />}
    {!isIddet && sync.isError && <p className="mb-4 text-sm font-semibold text-[#9d3b2d]" role="alert">{apiErrorMessage(sync.error, 'Shopify sync failed. Try again.')}</p>}
    <div className="mb-5 flex flex-col gap-3 rounded-2xl border border-card-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#eaf4ce] text-[#587126]"><ShoppingBag className="h-4 w-4" /></div><div><p className="text-sm font-bold">{isIddet ? 'Catalogue' : 'Shopify catalog'}</p><p className="font-mono-ui text-[10px] text-muted-foreground">{products.data?.length ?? 0} products available to turn into ads</p></div></div><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products" className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-[#91b44d] sm:w-56" data-testid="input-search-products" /></div>
    {filtered.length === 0 ? <EmptyState icon={Package} title={search ? 'No matching products' : 'Your catalog is empty'} detail={search ? 'Try a different product name.' : isIddet ? 'Ajoute ton premier produit pour créer une annonce.' : 'Sync Shopify to bring your product shelf into IDDET Ads.'} action={!search && (isIddet ? <Button onClick={() => setAdding(true)} variant="secondary" data-testid="button-empty-add"><Plus className="h-4 w-4" />Ajouter un produit</Button> : <Button onClick={handleSync} variant="secondary" data-testid="button-empty-sync"><RefreshCw className="h-4 w-4" />Sync Shopify</Button>)} /> :
      <div className="overflow-hidden rounded-2xl border border-card-border bg-card" data-testid="table-products"><div className="hidden grid-cols-[1.5fr_.6fr_.6fr_.8fr_auto] gap-4 border-b border-border bg-secondary/50 px-5 py-3 font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground md:grid"><span>Product</span><span>Price</span><span>Store status</span><span>Ad status</span><span /></div>{filtered.map(product => <ProductRow key={product.id} product={product} onCreate={() => setLocation(`/drafts?product=${encodeURIComponent(product.id)}`)} />)}</div>}
  </div>;
}

function ProductRow({ product, onCreate }: { product: Product; onCreate: () => void }) {
  const adTone = product.adStatus === 'published' ? 'lime' : product.adStatus === 'draft' ? 'amber' : 'neutral';
  return <div className="grid gap-4 border-b border-border p-4 last:border-b-0 md:grid-cols-[1.5fr_.6fr_.6fr_.8fr_auto] md:items-center md:px-5" data-testid={`row-product-${product.id}`}><div className="flex min-w-0 items-center gap-3"><div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-secondary">{product.imageUrl ? <img src={product.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-muted-foreground"><Package className="h-5 w-5" /></div>}</div><div className="min-w-0"><p className="truncate text-sm font-bold">{product.title}</p><p className="mt-1 truncate text-xs text-muted-foreground">{product.description || 'No description added'}</p></div></div><div className="font-mono-ui text-xs">{formatMoney(product.price, product.currency)}</div><div><StatusPill tone={product.status === 'active' ? 'lime' : 'neutral'}>{product.status}</StatusPill></div><div><StatusPill tone={adTone}>{product.adStatus.replace('_', ' ')}</StatusPill></div><div className="flex justify-end">{product.adStatus === 'not_started' ? <Button onClick={onCreate} variant="secondary" className="w-full md:w-auto" data-testid={`button-create-draft-${product.id}`}><Plus className="h-4 w-4" />Create draft</Button> : <Link href="/drafts" className="inline-flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground" data-testid={`link-view-draft-${product.id}`}>View ad <ArrowRight className="h-3.5 w-3.5" /></Link>}</div></div>;
}

function DraftComposer({ products, accounts, communities, onCreated }: { products: Product[]; accounts: IddetAccount[]; communities: IddetCommunity[]; onCreated: (draft: AdDraft) => void }) {
  const params = new URLSearchParams(window.location.search);
  const initialProduct = params.get('product') ?? products[0]?.id ?? '';
  const [productId, setProductId] = useState(initialProduct);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [communityId, setCommunityId] = useState(communities.find(c => c.isMember)?.id ?? communities[0]?.id ?? '');
  const create = useCreateAdDraft();
  const product = products.find(item => item.id === productId);
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!productId || !title.trim() || !content.trim() || !accountId || !communityId) return; create.mutate({ data: { productId, title: title.trim(), content: content.trim(), accountId, communityId } }, { onSuccess: onCreated }); };
  return <form onSubmit={submit} className="rounded-2xl border border-[#b8d87c] bg-[#f5f9e9] p-5 shadow-[var(--shadow-md)] md:p-6" data-testid="form-create-draft">
    <div className="flex items-start justify-between gap-4"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.15em] text-[#71833c]">New ad draft</p><h2 className="mt-1 font-display text-xl font-bold">Shape the story</h2></div><Sparkles className="h-5 w-5 text-[#7c9a35]" /></div>
    <div className="mt-5 grid gap-4 md:grid-cols-2"><label className="block text-xs font-bold">Product<select value={productId} onChange={e => setProductId(e.target.value)} className="mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-sm font-normal outline-none focus:border-[#91b44d]" data-testid="select-draft-product"><option value="">Choose a product</option>{products.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label className="block text-xs font-bold">Ad title<input value={title} onChange={e => setTitle(e.target.value)} placeholder={product ? `A sharper angle on ${product.title}` : 'Give this ad a title'} className="mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-sm font-normal outline-none focus:border-[#91b44d]" data-testid="input-draft-title" /></label></div>
    <label className="mt-4 block text-xs font-bold">Community copy<textarea value={content} onChange={e => setContent(e.target.value)} placeholder="Write like a person who knows the product and the community." rows={4} className="mt-2 w-full resize-none rounded-lg border border-input bg-card px-3 py-3 text-sm font-normal leading-6 outline-none focus:border-[#91b44d]" data-testid="textarea-draft-content" /></label>
    <div className="mt-4 grid gap-4 md:grid-cols-2"><label className="block text-xs font-bold">Publish as<select value={accountId} onChange={e => setAccountId(e.target.value)} className="mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-sm font-normal outline-none focus:border-[#91b44d]" data-testid="select-draft-account"><option value="">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.username}</option>)}</select></label><label className="block text-xs font-bold">Send to<select value={communityId} onChange={e => setCommunityId(e.target.value)} className="mt-2 h-11 w-full rounded-lg border border-input bg-card px-3 text-sm font-normal outline-none focus:border-[#91b44d]" data-testid="select-draft-community"><option value="">Choose a community</option>{communities.map(community => <option key={community.id} value={community.id}>{community.name} · {community.memberCount.toLocaleString()} members</option>)}</select></label></div>
    {create.isError && <p className="mt-4 text-sm font-semibold text-[#9d3b2d]" data-testid="status-create-error">Could not save this draft. Check the fields and try again.</p>}
    <div className="mt-5 flex justify-end"><Button type="submit" disabled={create.isPending || !productId || !title.trim() || !content.trim() || !accountId || !communityId} variant="secondary" data-testid="button-save-draft">{create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Save draft</Button></div>
  </form>;
}

function DraftCard({ draft, onPublish }: { draft: AdDraft; onPublish: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const publish = usePublishAdDraft();
  const [published, setPublished] = useState(false);
  const confirmPublish = () => publish.mutate({ id: draft.id }, { onSuccess: () => { setPublished(true); setConfirm(false); onPublish(); } });
  return <article className="rounded-2xl border border-card-border bg-card p-5 shadow-[var(--shadow-sm)]" data-testid={`card-draft-${draft.id}`}><div className="flex gap-4"><div className="hidden h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-secondary sm:block">{draft.imageUrl ? <img src={draft.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-muted-foreground"><Sparkles className="h-5 w-5" /></div>}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><StatusPill tone={published || draft.status === 'published' ? 'lime' : 'amber'}>{published ? 'published' : draft.status}</StatusPill><span className="font-mono-ui text-[10px] text-muted-foreground">{relativeDate(draft.createdAt)}</span></div><h3 className="mt-3 font-display text-lg font-bold">{draft.title}</h3><p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">{draft.content}</p></div></div><div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><Avatar name={draft.accountUsername} size="sm" />{draft.accountUsername}</span><span className="inline-flex items-center gap-1.5"><Hash className="h-3.5 w-3.5" />{draft.communityName}</span><span className="ml-auto">{draft.status === 'published' || published ? `Published ${formatDate(draft.publishedAt)}` : <>{confirm ? <span className="flex items-center gap-2"><span className="font-semibold text-foreground">Publish this ad?</span><Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setConfirm(false)} data-testid={`button-cancel-publish-${draft.id}`}>Cancel</Button><Button variant="coral" className="px-2 py-1 text-xs" onClick={confirmPublish} disabled={publish.isPending} data-testid={`button-confirm-publish-${draft.id}`}>{publish.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}Confirm</Button></span> : <Button variant="primary" className="px-3 py-2 text-xs" onClick={() => setConfirm(true)} data-testid={`button-publish-${draft.id}`}><Send className="h-3.5 w-3.5" />Review & publish</Button>}</>}</span></div>{publish.isError && <p className="mt-3 text-xs font-semibold text-[#9d3b2d]" data-testid={`status-publish-error-${draft.id}`}>{apiErrorMessage(publish.error, 'Publishing did not complete. Try again.')}</p>}{published && <div className="mt-3 rounded-lg bg-[#eaf4ce] px-3 py-2 text-xs font-bold text-[#587126]" data-testid={`status-published-${draft.id}`}><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />Published to {draft.communityName}</div>}</article>;
}

function Drafts() {
  const queryClient = useQueryClient();
  const drafts = useListAdDrafts();
  const products = useListProducts();
  const accounts = useListIddetAccounts();
  const communities = useListIddetCommunities();
  const [showComposer, setShowComposer] = useState(false);
  const [tab, setTab] = useState<'draft' | 'published'>('draft');
  const onCreated = (draft: AdDraft) => { queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() }); queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() }); setShowComposer(false); };
  if (drafts.isLoading || products.isLoading || accounts.isLoading || communities.isLoading) return <LoadingRows count={5} />;
  if (drafts.isError || products.isError || accounts.isError || communities.isError) return <ErrorState message="Draft workspace data is not available. Make sure your connection and IDDET setup are ready." />;
  const shown = (drafts.data ?? []).filter(draft => draft.status === tab);
  return <div className="rise"><PageHeader eyebrow="Publishing / ad desk" title="Make it community-ready." detail="Review the voice, choose the destination, and publish when the story is right." action={<Button onClick={() => setShowComposer(value => !value)} variant="secondary" data-testid="button-toggle-composer">{showComposer ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}{showComposer ? 'Close composer' : 'New ad draft'}</Button>} />
    {showComposer && <div className="mb-7"><DraftComposer products={products.data ?? []} accounts={accounts.data ?? []} communities={communities.data ?? []} onCreated={onCreated} /></div>}
    <div className="mb-5 flex items-center justify-between border-b border-border"><div className="flex gap-6"><button onClick={() => setTab('draft')} className={cx('border-b-2 px-1 pb-3 text-sm font-bold', tab === 'draft' ? 'border-[#7c9a35] text-foreground' : 'border-transparent text-muted-foreground')} data-testid="button-tab-drafts">In review <span className="ml-1 font-mono-ui text-[10px]">({(drafts.data ?? []).filter(d => d.status === 'draft').length})</span></button><button onClick={() => setTab('published')} className={cx('border-b-2 px-1 pb-3 text-sm font-bold', tab === 'published' ? 'border-[#7c9a35] text-foreground' : 'border-transparent text-muted-foreground')} data-testid="button-tab-published">Published <span className="ml-1 font-mono-ui text-[10px]">({(drafts.data ?? []).filter(d => d.status === 'published').length})</span></button></div><span className="hidden font-mono-ui text-[10px] uppercase tracking-[.12em] text-muted-foreground sm:block">IDDET destinations</span></div>
     {shown.length === 0 ? <EmptyState icon={tab === 'draft' ? Pencil : Send} title={tab === 'draft' ? 'No drafts in the queue' : 'Nothing published yet'} detail={tab === 'draft' ? 'Start with a product from your catalog and give it a community angle.' : 'Published ads will collect here once you send one live.'} action={tab === 'draft' && <Button onClick={() => setShowComposer(true)} variant="secondary" data-testid="button-empty-new-draft"><Plus className="h-4 w-4" />Start a draft</Button>} /> : <div className="grid gap-4">{shown.map(draft => <DraftCard key={draft.id} draft={draft} onPublish={() => { queryClient.invalidateQueries({ queryKey: getListAdDraftsQueryKey() }); queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() }); }} />)}</div>}
  </div>;
}

function Connections() {
  const queryClient = useQueryClient();
  const auth = useAuth();
  const connection = useGetShopifyConnection();
  const accounts = useListIddetAccounts();
  const communities = useListIddetCommunities();
  const connectIddet = useConnectIddetAccount();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const refreshShopify = () => {
    queryClient.invalidateQueries({ queryKey: getGetShopifyConnectionQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
  };
  const submitIddet = (event: React.FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    connectIddet.mutate(
      { data: { username: username.trim(), password } },
      {
        onSuccess: () => {
          setUsername('');
          setPassword('');
          queryClient.invalidateQueries({ queryKey: getListIddetAccountsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListIddetCommunitiesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetShopifyConnectionQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetOverviewQueryKey() });
        },
      },
    );
  };
  if (connection.isLoading || accounts.isLoading || communities.isLoading) return <LoadingRows count={5} />;
  if (connection.isError || accounts.isError || communities.isError) return <ErrorState message="Connection details could not be loaded. Try again in a moment." />;
  const store = connection.data;
  return <div className="rise"><PageHeader eyebrow="Setup / connections" title="Keep the line connected." detail="IDDET Ads needs two things to publish with confidence: your Shopify catalog and a destination identity." />
    <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
       {auth.mode === 'iddet' ? <section className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-iddet-workspace"><div className="flex items-center gap-3"><Avatar name={auth.user?.username ?? 'IDDET'} src={auth.user?.avatarUrl} /><div className="min-w-0"><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">Connecté</p><h2 className="truncate font-display text-xl font-bold">@{auth.user?.username}</h2></div><StatusPill tone="lime">actif</StatusPill></div><p className="mt-5 text-sm leading-6 text-muted-foreground">Ton compte IDDET est ton espace de travail et ton identité de publication. Tes produits, brouillons et annonces sont rattachés à ce compte.</p><Button variant="secondary" className="mt-5" onClick={auth.logout} data-testid="button-logout-connections"><LogOut className="h-4 w-4" />Se déconnecter</Button></section> : <section className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-shopify-connection"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#dcecb4] text-[#526d22]"><Store className="h-5 w-5" /></span><div><h2 className="font-display text-xl font-bold">Shopify store</h2><p className="text-xs text-muted-foreground">Managed by the Shopify embedded app session</p></div></div><div className="flex items-center gap-2"><Button variant="ghost" className="h-9 w-9 p-0" onClick={refreshShopify} data-testid="button-refresh-shopify" aria-label="Refresh Shopify session"><RefreshCw className="h-4 w-4" /></Button><StatusPill tone={store?.connected ? 'lime' : store?.status === 'needs_reauth' ? 'coral' : 'amber'}>{store?.connected ? 'connected' : store?.status === 'needs_reauth' ? 'reauthorization' : 'awaiting Shopify'}</StatusPill></div></div>
         {store?.connected ? <div className="mt-7 rounded-xl bg-[#eaf4ce] p-4"><div className="flex items-start justify-between gap-4"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.13em] text-[#71833c]">Current shop identity</p><p className="mt-2 font-display text-xl font-bold" data-testid="text-connected-store">{store.storeName ?? store.storeDomain}</p><p className="mt-1 font-mono-ui text-xs text-[#587126]">{store.storeDomain}</p></div><CheckCircle2 className="mt-1 h-5 w-5 text-[#587126]" /></div><div className="mt-4 grid gap-3 border-t border-[#cfe29e] pt-4 sm:grid-cols-2"><div><p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#71833c]">Shopify operator</p><p className="mt-1 text-sm font-bold">{store.shopifyUserName ?? 'Embedded session'}</p></div><div><p className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#71833c]">App status</p><p className="mt-1 text-sm font-bold">{store.status}</p></div></div></div> : <div className="mt-7 rounded-xl border border-dashed border-[#d9c986] bg-[#fbf3d7] p-5"><p className="font-bold">Shopify authentication is required.</p><p className="mt-2 text-sm leading-6 text-[#806b1b]">Open IDDET Ads from your Shopify admin to establish the managed installation session. There is no separate store login here.</p>{store?.authUrl && <a href={store.authUrl} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#243342] px-3.5 py-2.5 text-sm font-bold text-[#f6f0e0]" data-testid="link-shopify-auth">Continue in Shopify <ArrowRight className="h-4 w-4" /></a>}</div>}
         <div className="mt-6 border-t border-border pt-5"><div className="flex items-center justify-between"><p className="text-xs font-bold">Managed callback path</p><BadgeCheck className="h-4 w-4 text-[#71833c]" /></div><code className="mt-2 block overflow-x-auto rounded-lg bg-secondary px-3 py-2.5 font-mono-ui text-xs text-muted-foreground" data-testid="text-callback-path">{store?.callbackPath ?? 'Provided by the Shopify app configuration'}</code><p className="mt-2 text-xs leading-5 text-muted-foreground">Shop identity and session tokens come from Shopify App Bridge. Store credentials are never collected here.</p></div>
      </section>}
       <section className="space-y-5"><div className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-iddet-accounts"><div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">Publishing identity</p><h2 className="mt-1 font-display text-xl font-bold">IDDET accounts</h2></div><Users className="h-5 w-5 text-muted-foreground" /></div><form onSubmit={submitIddet} className="mt-5 rounded-xl border border-[#b8d87c] bg-[#f5f9e9] p-4" data-testid="form-connect-iddet"><p className="text-sm font-bold">Connect an IDDET account</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Your credentials are sent to the IDDET server and the returned token stays on the server.</p><div className="mt-3 grid gap-3 sm:grid-cols-2"><input value={username} onChange={event => setUsername(event.target.value)} placeholder="Username" autoComplete="username" className="h-10 rounded-lg border border-input bg-card px-3 text-sm outline-none focus:border-[#91b44d]" data-testid="input-iddet-username" /><input value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" type="password" autoComplete="current-password" className="h-10 rounded-lg border border-input bg-card px-3 text-sm outline-none focus:border-[#91b44d]" data-testid="input-iddet-password" /></div><div className="mt-3 flex items-center justify-between gap-3"><span className="font-mono-ui text-[10px] text-muted-foreground">hoosthubs-g.onrender.com/api</span><Button type="submit" disabled={connectIddet.isPending || !username.trim() || !password} variant="secondary" data-testid="button-connect-iddet">{connectIddet.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}Connect IDDET</Button></div>{connectIddet.isError && <p className="mt-3 text-xs font-semibold text-[#9d3b2d]" data-testid="status-connect-iddet-error">IDDET rejected the connection. Check the username and password.</p>}{connectIddet.isSuccess && <p className="mt-3 text-xs font-semibold text-[#587126]" data-testid="status-connect-iddet-success">IDDET account connected. Communities are refreshing.</p>}</form><div className="mt-5 space-y-2">{(accounts.data ?? []).length ? (accounts.data ?? []).map(account => <div key={account.id} className="flex items-center gap-3 rounded-xl bg-secondary/60 p-3" data-testid={`account-${account.id}`}><Avatar name={account.username} src={account.avatarUrl} /><div className="min-w-0"><p className="truncate text-sm font-bold">{account.username}</p><p className="font-mono-ui text-[10px] text-muted-foreground">Connected {formatDate(account.connectedAt)}</p></div><CheckCircle2 className="ml-auto h-4 w-4 text-[#71833c]" /></div>) : <p className="py-4 text-sm text-muted-foreground">No IDDET accounts connected yet.</p>}</div></div><div className="rounded-2xl border border-card-border bg-card p-5 md:p-6" data-testid="card-iddet-communities"><div className="flex items-center justify-between"><div><p className="font-mono-ui text-[10px] uppercase tracking-[.14em] text-muted-foreground">Publishing destinations</p><h2 className="mt-1 font-display text-xl font-bold">Communities</h2></div><Globe2 className="h-5 w-5 text-muted-foreground" /></div><div className="mt-5 space-y-2">{(communities.data ?? []).length ? (communities.data ?? []).map(community => <div key={community.id} className="flex items-center gap-3 rounded-xl bg-secondary/60 p-3" data-testid={`community-${community.id}`}><span className="grid h-8 w-8 place-items-center rounded-lg bg-[#eaf4ce] text-[#587126]"><Hash className="h-4 w-4" /></span><div className="min-w-0"><p className="truncate text-sm font-bold">{community.name}</p><p className="font-mono-ui text-[10px] text-muted-foreground">{community.memberCount.toLocaleString()} members · {community.isMember ? 'Member' : 'Available'}</p></div><StatusPill tone={community.isMember ? 'lime' : 'neutral'}>{community.isMember ? 'ready' : 'join first'}</StatusPill></div>) : <p className="py-4 text-sm text-muted-foreground">No communities available.</p>}</div></div></section>
    </div>
  </div>;
}

function Router() {
  return <ErrorBoundary><Shell><Switch><Route path="/" component={Overview} /><Route path="/products" component={Products} /><Route path="/drafts" component={Drafts} /><Route path="/connections" component={Connections} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

const shopifyContext = () => {
  const params = new URLSearchParams(window.location.search);
  return params.has('host') || params.has('shop') || params.has('embedded');
};

function App() {
  const [embeddedReady, setEmbeddedReady] = useState(() => Boolean(window.shopify?.idToken));
  // Ouvert depuis l'admin Shopify : on attend App Bridge au lieu d'afficher la connexion.
  const [waitingShopify, setWaitingShopify] = useState(() => shopifyContext());
  const [session, setSession] = useState<StoredSession | null>(() => readSession());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (embeddedReady) return;
    const interval = window.setInterval(() => {
      if (window.shopify?.idToken) setEmbeddedReady(true);
    }, 500);
    const timeout = window.setTimeout(() => setWaitingShopify(false), 6000);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [embeddedReady]);

  useEffect(() => {
    const onExpired = () => {
      queryClient.clear();
      setSession(null);
      setNotice('Ta session a expiré. Reconnecte-toi.');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    queryClient.clear();
    setNotice(null);
    setSession(null);
  }, []);
  const onAuthed = useCallback((next: StoredSession) => {
    queryClient.clear();
    saveSession(next);
    setNotice(null);
    setSession(next);
  }, []);

  const auth = useMemo(
    () => ({ mode: embeddedReady ? ('shopify' as const) : ('iddet' as const), user: embeddedReady ? null : (session?.user ?? null), logout }),
    [embeddedReady, session, logout],
  );

  let content: ReactNode;
  if (embeddedReady || session) {
    content = <AuthContext.Provider value={auth} key={embeddedReady ? 'shopify' : session?.user.id}><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter></AuthContext.Provider>;
  } else if (waitingShopify) {
    content = <SplashState />;
  } else {
    content = <AuthScreen onAuthed={onAuthed} notice={notice} />;
  }
  return <QueryClientProvider client={queryClient}><TooltipProvider>{content}<Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;