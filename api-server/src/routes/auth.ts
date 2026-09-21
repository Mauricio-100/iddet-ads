import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { activitiesTable, db, iddetAccountsTable } from "@workspace/db";
import { authenticateRequest, SessionError, signIddetSession } from "../lib/session";

const router: IRouter = Router();
const IDDET_API_BASE_URL = (
  process.env.IDDET_API_BASE_URL ?? "https://hoosthubs-g.onrender.com"
).replace(/\/$/, "");

// Render met les services gratuits en veille : le premier appel peut prendre ~1 minute.
const UPSTREAM_TIMEOUT_MS = 90_000;

class AuthHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type IddetLogin = { access_token: string; user_id: string; username: string; avatar_url: string | null };

async function readDetail(response: globalThis.Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { detail?: unknown; error?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // corps non JSON : on garde le message par défaut
  }
  return null;
}

async function upstream(path: string, init: RequestInit): Promise<globalThis.Response> {
  try {
    return await fetch(`${IDDET_API_BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new AuthHttpError(502, "Le serveur IDDET ne répond pas. Réessaie dans un instant.");
  }
}

async function iddetLogin(username: string, password: string): Promise<IddetLogin> {
  const response = await upstream("/api/token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password }),
  });
  if (response.status === 401 || response.status === 400 || response.status === 404) {
    throw new AuthHttpError(401, "Nom d'utilisateur ou mot de passe incorrect.");
  }
  if (response.status === 429) {
    throw new AuthHttpError(429, "Trop de tentatives. Réessaie dans quelques minutes.");
  }
  if (!response.ok) throw new AuthHttpError(502, "Le serveur IDDET est indisponible.");

  const payload = (await response.json()) as Partial<IddetLogin>;
  if (!payload.access_token || !payload.username) {
    throw new AuthHttpError(502, "Réponse de connexion IDDET invalide.");
  }
  return {
    access_token: payload.access_token,
    user_id: payload.user_id ?? payload.username,
    username: payload.username,
    avatar_url: payload.avatar_url ?? null,
  };
}

/** Le compte avec lequel on se connecte devient automatiquement le compte de publication. */
async function linkPublishingAccount(workspace: string, login: IddetLogin): Promise<string> {
  const avatarUrl =
    login.avatar_url ??
    `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(login.username)}`;
  const [existing] = await db
    .select({ id: iddetAccountsTable.id })
    .from(iddetAccountsTable)
    .where(and(eq(iddetAccountsTable.shopDomain, workspace), eq(iddetAccountsTable.username, login.username)));

  if (existing) {
    await db
      .update(iddetAccountsTable)
      .set({ accessToken: login.access_token, avatarUrl, connectedAt: new Date() })
      .where(and(eq(iddetAccountsTable.id, existing.id), eq(iddetAccountsTable.shopDomain, workspace)));
    return avatarUrl;
  }

  await db.insert(iddetAccountsTable).values({
    id: `iddet_${workspace.replace(/[^a-z0-9]+/gi, "_")}_${login.user_id}`,
    shopDomain: workspace,
    username: login.username,
    avatarUrl,
    accessToken: login.access_token,
  });
  await db.insert(activitiesTable).values({
    id: `activity_${randomUUID()}`,
    shopDomain: workspace,
    type: "connection",
    label: "Compte IDDET connecté",
    detail: `@${login.username} est prêt à publier`,
  });
  return avatarUrl;
}

async function startSession(login: IddetLogin) {
  const workspace = `iddet:${login.user_id}`;
  const avatarUrl = await linkPublishingAccount(workspace, login);
  const session = signIddetSession({ id: login.user_id, username: login.username }, login.access_token);
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    user: { id: login.user_id, username: login.username, avatarUrl },
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const username = text(req.body?.username).trim();
  const password = text(req.body?.password);
  if (!username || !password) {
    res.status(400).json({ error: "Renseigne ton nom d'utilisateur et ton mot de passe." });
    return;
  }
  try {
    res.json(await startSession(await iddetLogin(username, password)));
  } catch (error) {
    if (error instanceof AuthHttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/auth/register", async (req, res): Promise<void> => {
  const username = text(req.body?.username).trim();
  const password = text(req.body?.password);
  const email = text(req.body?.email).trim();

  if (!/^[a-zA-Z0-9_.]{3,50}$/.test(username)) {
    res.status(400).json({ error: "Nom d'utilisateur : 3 à 50 caractères (lettres, chiffres, _ et .)." });
    return;
  }
  if (password.length < 6 || password.length > 100) {
    res.status(400).json({ error: "Le mot de passe doit contenir entre 6 et 100 caractères." });
    return;
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: "Adresse e-mail invalide." });
    return;
  }

  try {
    const response = await upstream("/api/users/register", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username, password, ...(email ? { email } : {}) }),
    });
    if (!response.ok) {
      const detail = await readDetail(response);
      if (response.status === 400 || response.status === 409) {
        throw new AuthHttpError(409, detail ?? "Nom d'utilisateur ou e-mail déjà utilisé.");
      }
      if (response.status === 422) throw new AuthHttpError(400, "Vérifie les champs saisis.");
      throw new AuthHttpError(502, "Le serveur IDDET est indisponible.");
    }
    res.status(201).json(await startSession(await iddetLogin(username, password)));
  } catch (error) {
    if (error instanceof AuthHttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.get("/auth/me", async (req, res): Promise<void> => {
  try {
    const session = await authenticateRequest(req);
    res.json({ kind: session.kind, username: session.userName, workspace: session.shopName });
  } catch (error) {
    res.status(error instanceof SessionError ? error.status : 401).json({
      error: error instanceof Error ? error.message : "Connexion requise.",
    });
  }
});

export default router;
