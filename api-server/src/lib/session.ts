import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { logger } from "./logger";
import { authenticateShopifyRequest, type ShopifySession } from "./shopify-auth";

/**
 * Une session de l'app est soit :
 *  - "iddet"  : l'utilisateur s'est connecté (ou inscrit) avec son compte IDDET.
 *               Son espace de travail est `iddet:<user_id>`.
 *  - "shopify": l'app est ouverte depuis l'admin Shopify (session App Bridge).
 */
export type AppSession = ShopifySession & { kind: "shopify" | "iddet" };

type IddetSessionClaims = {
  typ: "iddet-session";
  sub: string;
  uid: string;
  iat: number;
  exp: number;
};

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: number = 401,
  ) {
    super(message);
  }
}

const MAX_SESSION_SECONDS = 6 * 24 * 60 * 60; // les jetons IDDET durent 7 jours

let cachedSecret: string | null = null;
function sessionSecret(): string {
  if (cachedSecret !== null) return cachedSecret;
  const configured = process.env.SESSION_SECRET ?? "";
  let secret: string;
  if (configured.length >= 16) {
    secret = configured;
  } else {
    logger.warn(
      "SESSION_SECRET est absent (16 caractères minimum) : secret temporaire utilisé, les sessions seront perdues à chaque redémarrage.",
    );
    secret = randomBytes(32).toString("hex");
  }
  cachedSecret = secret;
  return secret;
}

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

function sign(signed: string): string {
  return createHmac("sha256", sessionSecret()).update(signed).digest("base64url");
}

function readPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Crée le jeton de session de l'app (le jeton IDDET reste côté serveur). */
export function signIddetSession(
  user: { id: string; username: string },
  upstreamToken?: string,
): { token: string; expiresAt: number } {
  const iat = Math.floor(Date.now() / 1000);
  let exp = iat + MAX_SESSION_SECONDS;
  const upstreamExp = upstreamToken ? Number(readPayload(upstreamToken)?.exp) : NaN;
  if (Number.isFinite(upstreamExp) && upstreamExp - 60 > iat) exp = Math.min(exp, upstreamExp - 60);

  const claims: IddetSessionClaims = { typ: "iddet-session", sub: user.username, uid: user.id, iat, exp };
  const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return { token: `${signed}.${sign(signed)}`, expiresAt: exp };
}

function verifyIddetSession(token: string): IddetSessionClaims {
  const parts = token.split(".");
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const actual = Buffer.from(parts[2] ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new SessionError("Session invalide. Reconnecte-toi.");
  }
  const claims = readPayload(token) as Partial<IddetSessionClaims> | null;
  if (!claims || claims.typ !== "iddet-session" || !claims.uid || !claims.sub || !claims.exp) {
    throw new SessionError("Session invalide. Reconnecte-toi.");
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new SessionError("Session expirée. Reconnecte-toi.");
  }
  return claims as IddetSessionClaims;
}

export async function authenticateRequest(req: Request): Promise<AppSession> {
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw new SessionError("Connexion requise.");

  if (readPayload(token)?.typ === "iddet-session") {
    const claims = verifyIddetSession(token);
    return {
      kind: "iddet",
      shopDomain: `iddet:${claims.uid}`,
      shopName: claims.sub,
      userId: claims.uid,
      userName: claims.sub,
      accessToken: null,
    };
  }

  const shopify = await authenticateShopifyRequest(req);
  return { ...shopify, kind: "shopify" };
}
