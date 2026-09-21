import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import {
  activitiesTable,
  adDraftsTable,
  db,
  iddetAccountsTable,
  iddetCommunitiesTable,
  productsTable,
  shopifyStoresTable,
} from "@workspace/db";
import {
  ConnectIddetAccountBody,
  CreateAdDraftBody,
  GetOverviewResponse,
  GetShopifyConnectionResponse,
  ListAdDraftsResponse,
  ListIddetAccountsResponse,
  ListIddetCommunitiesResponse,
  ListProductsResponse,
  PublishAdDraftParams,
  PublishAdDraftResponse,
  SyncShopifyProductsResponse,
} from "@workspace/api-zod";
import { authenticateRequest, SessionError, type AppSession } from "../lib/session";
import { shopifyGraphql } from "../lib/shopify-auth";

const router: IRouter = Router();
const IDDET_API_BASE_URL = (
  process.env.IDDET_API_BASE_URL ?? "https://hoosthubs-g.onrender.com"
).replace(/\/$/, "");

class RemoteIddetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const now = () => new Date();
const toIso = (value: Date | string | null): string | null =>
  value == null ? null : new Date(value).toISOString();

async function iddetRequest<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const response = await fetch(`${IDDET_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `IDDET a répondu avec le statut ${response.status}.`;
    try {
      const payload = (await response.json()) as { detail?: string; error?: string };
      if (payload.detail || payload.error) message = payload.detail ?? payload.error ?? message;
    } catch {
      // Keep the status-based message when the upstream body is not JSON.
    }
    throw new RemoteIddetError(response.status, message);
  }
  return (await response.json()) as T;
}

function remoteErrorResponse(res: Response, error: unknown): void {
  if (error instanceof RemoteIddetError) {
    res
      .status(
        error.status === 401
          ? 401
          : error.status >= 400 && error.status < 500
            ? error.status
            : 502,
      )
      .json({
        error:
          error.status === 401
            ? "Ta connexion IDDET a expiré. Reconnecte-toi pour publier."
            : error.message,
      });
    return;
  }
  const message = error instanceof Error ? error.message : "Le service distant est indisponible.";
  res.status(502).json({ error: message });
}

function appBaseUrl(req: { protocol: string; get(name: string): string | undefined }): string {
  const configured = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0];
  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0];
  if (forwardedHost) return `${forwardedProto ?? req.protocol}://${forwardedHost}`;
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

async function requireSession(req: Request, res: Response): Promise<AppSession | null> {
  try {
    return await authenticateRequest(req);
  } catch (error) {
    if (error instanceof SessionError) {
      res.status(error.status).json({ error: error.message });
      return null;
    }
    const message = error instanceof Error ? error.message : "";
    if (message.includes("SHOPIFY_API_SECRET")) {
      res.status(503).json({ error: "Shopify App credentials are not configured on the server." });
      return null;
    }
    res.status(401).json({ error: "Session expirée. Reconnecte-toi ou rouvre IDDET Ads depuis Shopify." });
    return null;
  }
}

function httpUrl(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 2000) throw new Error(`${label} invalide.`);
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label} invalide (elle doit commencer par http:// ou https://).`);
  }
}

function productStatus(status: string | undefined): "active" | "draft" | "archived" {
  if (status === "ARCHIVED") return "archived";
  if (status === "DRAFT") return "draft";
  return "active";
}

function productPayload(product: typeof productsTable.$inferSelect) {
  return {
    ...product,
    price: Number(product.price),
    imageUrl: product.imageUrl ?? null,
    createdAt: toIso(product.createdAt),
  };
}

async function getDraft(shopDomain: string, id: string) {
  const [row] = await db
    .select({
      id: adDraftsTable.id,
      productId: adDraftsTable.productId,
      productTitle: productsTable.title,
      title: adDraftsTable.title,
      content: adDraftsTable.content,
      imageUrl: productsTable.imageUrl,
      productUrl: productsTable.productUrl,
      status: adDraftsTable.status,
      accountId: adDraftsTable.accountId,
      accountUsername: iddetAccountsTable.username,
      communityId: adDraftsTable.communityId,
      communityName: iddetCommunitiesTable.name,
      communitySlug: iddetCommunitiesTable.slug,
      remoteActfileId: adDraftsTable.remoteActfileId,
      publishedAt: adDraftsTable.publishedAt,
      createdAt: adDraftsTable.createdAt,
    })
    .from(adDraftsTable)
    .innerJoin(
      productsTable,
      and(eq(adDraftsTable.productId, productsTable.id), eq(productsTable.shopDomain, shopDomain)),
    )
    .innerJoin(
      iddetAccountsTable,
      and(eq(adDraftsTable.accountId, iddetAccountsTable.id), eq(iddetAccountsTable.shopDomain, shopDomain)),
    )
    .innerJoin(
      iddetCommunitiesTable,
      and(eq(adDraftsTable.communityId, iddetCommunitiesTable.id), eq(iddetCommunitiesTable.shopDomain, shopDomain)),
    )
    .where(and(eq(adDraftsTable.id, id), eq(adDraftsTable.shopDomain, shopDomain)));

  if (!row) return undefined;
  // Lien produit réel (handle Shopify ou lien saisi à la main). À défaut, page d'accueil de la boutique.
  const destinationUrl = row.productUrl ?? (shopDomain.startsWith("iddet:") ? "" : `https://${shopDomain}/`);
  return {
    ...row,
    destinationUrl,
    publishedAt: toIso(row.publishedAt),
    createdAt: toIso(row.createdAt),
  };
}

router.get("/overview", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const [store] = await db
    .select()
    .from(shopifyStoresTable)
    .where(eq(shopifyStoresTable.storeDomain, session.shopDomain));
  const [{ value: productCount }] = await db
    .select({ value: count() })
    .from(productsTable)
    .where(eq(productsTable.shopDomain, session.shopDomain));
  const [{ value: draftCount }] = await db
    .select({ value: count() })
    .from(adDraftsTable)
    .where(and(eq(adDraftsTable.shopDomain, session.shopDomain), eq(adDraftsTable.status, "draft")));
  const [{ value: publishedCount }] = await db
    .select({ value: count() })
    .from(adDraftsTable)
    .where(and(eq(adDraftsTable.shopDomain, session.shopDomain), eq(adDraftsTable.status, "published")));
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const [{ value: publishedThisWeek }] = await db
    .select({ value: count() })
    .from(adDraftsTable)
    .where(
      and(
        eq(adDraftsTable.shopDomain, session.shopDomain),
        eq(adDraftsTable.status, "published"),
        gte(adDraftsTable.publishedAt, weekStart),
      ),
    );
  const [{ value: accountCount }] = await db
    .select({ value: count() })
    .from(iddetAccountsTable)
    .where(eq(iddetAccountsTable.shopDomain, session.shopDomain));
  const activities = await db
    .select()
    .from(activitiesTable)
    .where(eq(activitiesTable.shopDomain, session.shopDomain))
    .orderBy(desc(activitiesTable.createdAt))
    .limit(6);

  res.json(
    GetOverviewResponse.parse({
      storeStatus:
        session.kind === "iddet" || store?.status === "connected" ? "connected" : "needs_reauth",
      storeName: store?.storeName ?? session.shopName,
      productCount: Number(productCount),
      draftCount: Number(draftCount),
      publishedCount: Number(publishedCount),
      connectedAccountCount: Number(accountCount),
      publishedThisWeek: Number(publishedThisWeek),
      activity: activities.map((activity) => ({
        ...activity,
        createdAt: toIso(activity.createdAt),
      })),
    }),
  );
});

router.get("/shopify/connection", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const [store] = await db
    .select()
    .from(shopifyStoresTable)
    .where(eq(shopifyStoresTable.storeDomain, session.shopDomain));
  const [{ value: accountCount }] = await db
    .select({ value: count() })
    .from(iddetAccountsTable)
    .where(and(eq(iddetAccountsTable.shopDomain, session.shopDomain), isNotNull(iddetAccountsTable.accessToken)));

  res.json(
    GetShopifyConnectionResponse.parse({
      connected: session.kind === "iddet" || Boolean(session.accessToken),
      storeDomain: session.shopDomain,
      storeName: store?.storeName ?? session.shopName,
      status: session.kind === "iddet" || session.accessToken ? "connected" : "needs_reauth",
      appUrl: appBaseUrl(req),
      callbackPath: null,
      authUrl: null,
      shopifyUserName: session.userName,
      iddetConnected: Number(accountCount) > 0,
    }),
  );
});

router.post("/shopify/sync", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  if (session.kind === "iddet") {
    res.status(400).json({
      error: "La synchronisation Shopify n'est disponible que depuis l'app ouverte dans Shopify. Ajoute tes produits manuellement.",
    });
    return;
  }
  if (!session.accessToken) {
    res.status(503).json({ error: "Shopify Admin access is not ready. Reopen the embedded app to authorize it." });
    return;
  }

  const query = `query Products($first: Int!) {
    shop { name }
    products(first: $first) {
      nodes {
        id
        handle
        title
        description
        descriptionHtml
        status
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount currencyCode } }
      }
    }
  }`;

  try {
    const payload = await shopifyGraphql<{
      shop: { name: string };
      products: {
        nodes: Array<{
          id: string;
          handle?: string;
          title: string;
          description?: string;
          descriptionHtml?: string;
          status?: string;
          featuredImage?: { url?: string | null } | null;
          priceRangeV2?: { minVariantPrice?: { amount?: string; currencyCode?: string } | null } | null;
        }>;
      };
    }>(session, query, { first: 100 });
    await db
      .update(shopifyStoresTable)
      .set({
        storeName: payload.shop.name,
        status: "connected",
        updatedAt: now(),
      })
      .where(eq(shopifyStoresTable.storeDomain, session.shopDomain));

    for (const product of payload.products.nodes) {
      const price = product.priceRangeV2?.minVariantPrice?.amount ?? "0";
      const currency = product.priceRangeV2?.minVariantPrice?.currencyCode ?? "USD";
      const productUrl = product.handle
        ? `https://${session.shopDomain}/products/${encodeURIComponent(product.handle)}`
        : null;
      await db
        .insert(productsTable)
        .values({
          id: `${session.shopDomain}:${product.id}`,
          shopDomain: session.shopDomain,
          title: product.title,
          description: (product.description ?? product.descriptionHtml ?? "").replace(/<[^>]+>/g, "").trim(),
          price,
          currency,
          imageUrl: product.featuredImage?.url ?? null,
          productUrl,
          status: productStatus(product.status),
          adStatus: "not_started",
        })
        .onConflictDoUpdate({
          target: productsTable.id,
          set: {
            title: product.title,
            description: (product.description ?? product.descriptionHtml ?? "").replace(/<[^>]+>/g, "").trim(),
            price,
            currency,
            imageUrl: product.featuredImage?.url ?? null,
            productUrl,
            status: productStatus(product.status),
          },
        });
    }
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Impossible de synchroniser Shopify." });
    return;
  }

  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.shopDomain, session.shopDomain))
    .orderBy(desc(productsTable.createdAt));
  res.json(SyncShopifyProductsResponse.parse(products.map(productPayload)));
});

router.post("/products", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const price = Number(body.price);
  const currency =
    typeof body.currency === "string" && /^[A-Za-z]{3}$/.test(body.currency.trim())
      ? body.currency.trim().toUpperCase()
      : "EUR";
  if (!title || title.length > 200) {
    res.status(400).json({ error: "Le nom du produit est requis (200 caractères maximum)." });
    return;
  }
  if (description.length > 2000) {
    res.status(400).json({ error: "La description est trop longue (2000 caractères maximum)." });
    return;
  }
  if (!Number.isFinite(price) || price < 0 || price > 1_000_000_000) {
    res.status(400).json({ error: "Prix invalide." });
    return;
  }
  let imageUrl: string | null;
  let productUrl: string | null;
  try {
    imageUrl = httpUrl(body.imageUrl, "L'adresse de l'image");
    productUrl = httpUrl(body.productUrl, "Le lien du produit");
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Champ invalide." });
    return;
  }
  const [created] = await db
    .insert(productsTable)
    .values({
      id: `${session.shopDomain}:manual:${randomUUID()}`,
      shopDomain: session.shopDomain,
      title,
      description,
      price: price.toFixed(2),
      currency,
      imageUrl,
      productUrl,
    })
    .returning();
  await db.insert(activitiesTable).values({
    id: `activity_${randomUUID()}`,
    shopDomain: session.shopDomain,
    type: "product",
    label: "Produit ajouté",
    detail: title,
  });
  res.status(201).json(productPayload(created));
});

router.get("/products", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const products = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.shopDomain, session.shopDomain))
    .orderBy(desc(productsTable.createdAt));
  res.json(ListProductsResponse.parse(products.map(productPayload)));
});

router.get("/iddet/accounts", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const accounts = await db
    .select()
    .from(iddetAccountsTable)
    .where(eq(iddetAccountsTable.shopDomain, session.shopDomain))
    .orderBy(iddetAccountsTable.username);
  res.json(
    ListIddetAccountsResponse.parse(
      accounts.map((account) => ({
        ...account,
        connectedAt: toIso(account.connectedAt),
      })),
    ),
  );
});

router.post("/iddet/connect", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = ConnectIddetAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const form = new URLSearchParams({
    username: parsed.data.username,
    password: parsed.data.password,
  });
  let response: globalThis.Response;
  try {
    response = await fetch(`${IDDET_API_BASE_URL}/api/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
  } catch {
    res.status(502).json({ error: "Le serveur IDDET est indisponible." });
    return;
  }
  if (!response.ok) {
    res.status(response.status === 401 ? 401 : 502).json({
      error: response.status === 401 ? "Identifiants IDDET incorrects." : "Le serveur IDDET est indisponible.",
    });
    return;
  }

  const payload = (await response.json()) as {
    access_token?: string;
    user_id?: string;
    username?: string;
    avatar_url?: string | null;
  };
  if (!payload.access_token || !payload.username) {
    res.status(502).json({ error: "Réponse de connexion IDDET invalide." });
    return;
  }

  const username = payload.username;
  const avatarUrl =
    payload.avatar_url ??
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(username)}`;
  const [existing] = await db
    .select({ id: iddetAccountsTable.id })
    .from(iddetAccountsTable)
    .where(and(eq(iddetAccountsTable.shopDomain, session.shopDomain), eq(iddetAccountsTable.username, username)));
  const account = existing
    ? (
        await db
          .update(iddetAccountsTable)
          .set({ accessToken: payload.access_token, avatarUrl, connectedAt: now() })
          .where(and(eq(iddetAccountsTable.id, existing.id), eq(iddetAccountsTable.shopDomain, session.shopDomain)))
          .returning()
      )[0]
    : (
        await db
          .insert(iddetAccountsTable)
          .values({
            id: `iddet_${session.shopDomain.replace(/[^a-z0-9]+/gi, "_")}_${payload.user_id ?? randomUUID()}`,
            shopDomain: session.shopDomain,
            username,
            avatarUrl,
            accessToken: payload.access_token,
          })
          .returning()
      )[0];

  res.json({
    id: account.id,
    username: account.username,
    avatarUrl: account.avatarUrl,
    connectedAt: toIso(account.connectedAt),
  });
});

router.get("/iddet/communities", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const [account] = await db
    .select()
    .from(iddetAccountsTable)
    .where(and(eq(iddetAccountsTable.shopDomain, session.shopDomain), isNotNull(iddetAccountsTable.accessToken)))
    .limit(1);

  if (account?.accessToken) {
    try {
      const remoteCommunities = await iddetRequest<
        Array<{
          id: string;
          slug: string;
          name: string;
          members_count?: number;
          is_member?: boolean;
        }>
      >("/api/communities?limit=200&sort=popular", {}, account.accessToken);
      for (const community of remoteCommunities) {
        const [existing] = await db
          .select({ id: iddetCommunitiesTable.id })
          .from(iddetCommunitiesTable)
          .where(and(eq(iddetCommunitiesTable.shopDomain, session.shopDomain), eq(iddetCommunitiesTable.slug, community.slug)));
        if (existing) {
          await db
            .update(iddetCommunitiesTable)
            .set({
              name: community.name,
              memberCount: Number(community.members_count ?? 0),
              isMember: Boolean(community.is_member),
            })
            .where(and(eq(iddetCommunitiesTable.id, existing.id), eq(iddetCommunitiesTable.shopDomain, session.shopDomain)));
        } else {
          await db.insert(iddetCommunitiesTable).values({
            id: `iddet_community_${session.shopDomain.replace(/[^a-z0-9]+/gi, "_")}_${community.id}`,
            shopDomain: session.shopDomain,
            slug: community.slug,
            name: community.name,
            memberCount: Number(community.members_count ?? 0),
            isMember: Boolean(community.is_member),
          });
        }
      }
    } catch (error) {
      remoteErrorResponse(res, error);
      return;
    }
  }

  const communities = await db
    .select()
    .from(iddetCommunitiesTable)
    .where(eq(iddetCommunitiesTable.shopDomain, session.shopDomain))
    .orderBy(desc(iddetCommunitiesTable.memberCount));
  res.json(ListIddetCommunitiesResponse.parse(communities));
});

router.get("/ad-drafts", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const drafts = await db
    .select({ id: adDraftsTable.id })
    .from(adDraftsTable)
    .where(eq(adDraftsTable.shopDomain, session.shopDomain))
    .orderBy(desc(adDraftsTable.createdAt));
  const hydrated = (
    await Promise.all(drafts.map((draft) => getDraft(session.shopDomain, draft.id)))
  ).filter((draft): draft is NonNullable<typeof draft> => Boolean(draft));
  res.json(ListAdDraftsResponse.parse(hydrated));
});

router.post("/ad-drafts", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const parsed = CreateAdDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const [product] = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.id, data.productId), eq(productsTable.shopDomain, session.shopDomain)));
  const [account] = await db
    .select()
    .from(iddetAccountsTable)
    .where(and(eq(iddetAccountsTable.id, data.accountId), eq(iddetAccountsTable.shopDomain, session.shopDomain)));
  const [community] = await db
    .select()
    .from(iddetCommunitiesTable)
    .where(and(eq(iddetCommunitiesTable.id, data.communityId), eq(iddetCommunitiesTable.shopDomain, session.shopDomain)));
  if (!product || !account || !community) {
    res.status(400).json({ error: "Produit, compte IDDET ou communauté introuvable." });
    return;
  }

  const id = `ad_draft_${randomUUID()}`;
  await db.insert(adDraftsTable).values({
    id,
    shopDomain: session.shopDomain,
    productId: product.id,
    title: data.title,
    content: data.content,
    accountId: account.id,
    communityId: community.id,
  });
  await db
    .update(productsTable)
    .set({ adStatus: "draft" })
    .where(and(eq(productsTable.id, product.id), eq(productsTable.shopDomain, session.shopDomain)));
  await db.insert(activitiesTable).values({
    id: `activity_${randomUUID()}`,
    shopDomain: session.shopDomain,
    type: "draft",
    label: "Brouillon créé",
    detail: `${product.title} attend sa publication dans ${community.name}`,
  });

  const draft = await getDraft(session.shopDomain, id);
  res.status(201).json(draft);
});

router.post("/ad-drafts/:id/publish", async (req, res): Promise<void> => {
  const session = await requireSession(req, res);
  if (!session) return;
  const params = PublishAdDraftParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const existing = await getDraft(session.shopDomain, params.data.id);
  if (!existing) {
    res.status(404).json({ error: "Brouillon introuvable." });
    return;
  }
  const [publishContext] = await db
    .select({
      accessToken: iddetAccountsTable.accessToken,
      communitySlug: iddetCommunitiesTable.slug,
    })
    .from(adDraftsTable)
    .innerJoin(
      iddetAccountsTable,
      and(eq(adDraftsTable.accountId, iddetAccountsTable.id), eq(iddetAccountsTable.shopDomain, session.shopDomain)),
    )
    .innerJoin(
      iddetCommunitiesTable,
      and(eq(adDraftsTable.communityId, iddetCommunitiesTable.id), eq(iddetCommunitiesTable.shopDomain, session.shopDomain)),
    )
    .where(and(eq(adDraftsTable.id, params.data.id), eq(adDraftsTable.shopDomain, session.shopDomain)));
  if (!publishContext?.accessToken) {
    res.status(400).json({ error: "Connecte un compte IDDET réel avant de publier." });
    return;
  }

  // Titre en gras, texte de l'annonce, puis lien vers le produit (le rendu Markdown des actfiles
  // gère titres, gras et liens, mais pas les images).
  const actfileContent = [
    `**${existing.title}**`,
    existing.content,
    existing.destinationUrl ? `[Voir le produit](${existing.destinationUrl})` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const accessToken = publishContext.accessToken;
  const postActfile = () =>
    iddetRequest<{ id?: string }>(
      "/api/actfile",
      {
        method: "POST",
        body: JSON.stringify({
          content: actfileContent,
          category: "Autres",
          community_slug: publishContext.communitySlug,
        }),
      },
      accessToken,
    );

  let remoteActfile: { id?: string };
  try {
    try {
      remoteActfile = await postActfile();
    } catch (error) {
      // Publier exige d'être membre : on rejoint la communauté puis on réessaie une fois.
      if (error instanceof RemoteIddetError && error.status === 403 && /membre/i.test(error.message)) {
        await iddetRequest(
          `/api/communities/${encodeURIComponent(publishContext.communitySlug)}/join`,
          { method: "POST" },
          accessToken,
        );
        await db
          .update(iddetCommunitiesTable)
          .set({ isMember: true })
          .where(and(eq(iddetCommunitiesTable.id, existing.communityId), eq(iddetCommunitiesTable.shopDomain, session.shopDomain)));
        remoteActfile = await postActfile();
      } else {
        throw error;
      }
    }
  } catch (error) {
    remoteErrorResponse(res, error);
    return;
  }

  const publishedAt = now();
  await db
    .update(adDraftsTable)
    .set({
      status: "published",
      publishedAt,
      remoteActfileId: remoteActfile.id ?? null,
    })
    .where(and(eq(adDraftsTable.id, params.data.id), eq(adDraftsTable.shopDomain, session.shopDomain)));
  await db
    .update(productsTable)
    .set({ adStatus: "published" })
    .where(and(eq(productsTable.id, existing.productId), eq(productsTable.shopDomain, session.shopDomain)));
  await db.insert(activitiesTable).values({
    id: `activity_${randomUUID()}`,
    shopDomain: session.shopDomain,
    type: "publish",
    label: "Annonce publiée",
    detail: `${existing.productTitle} dans ${existing.communityName}`,
  });
  const published = await getDraft(session.shopDomain, params.data.id);
  res.json(PublishAdDraftResponse.parse(published));
});

export default router;