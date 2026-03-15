// DIMA signature!!
// major overhaul w   why the   why the fuck am i getting suggestions what

// im dima yk... im so cool.... 

// ─── helpers ──────────────────────────────────────────────────────────────────

function corsify(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ─── user-agent check ──────────────────────────────────────────────────────────

function isBrowser(userAgent) {
  const browserPatterns = ["Mozilla", "Chrome", "Safari", "Edg/", "Opera", "Firefox"];
  return browserPatterns.some(pattern => userAgent.includes(pattern));
}

// ─── body parsing ──────────────────────────────────────────────────────────────

async function parseBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json();
  } else if (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  ) {
    const formData = await request.formData();
    const obj = {};
    for (const [key, value] of formData.entries()) {
      obj[key] = value;
    }
    return obj;
  } else {
    throw new Error('Unsupported content type. Please use JSON or form data.');
  }
}

// ─── boolean coercion ──────────────────────────────────────────────────────────

function normalizeBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
  }
  if (typeof value === 'number') return value !== 0;
  // FIX: arrays/objects now throw instead of silently falling back to defaultValue
  throw new Error(`Invalid boolean value for parameter: ${JSON.stringify(value)}`);
}

// ─── input validation ──────────────────────────────────────────────────────────
// FIX: userId and groupId are now validated and coerced to safe integers before use.

function sanitizeRobloxId(value, fieldName) {
  if (value === undefined || value === null) return null;
  // FIX: explicitly reject scientific notation strings like "1e5" since
  // parseInt("1e5", 10) === 1, not 100000, which silently truncates the value.
  if (typeof value === 'string' && /[eE]/.test(value)) {
    throw new Error(`Invalid ${fieldName}: scientific notation is not allowed, got "${value}"`);
  }
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0 || String(n) !== String(value).trim()) {
    throw new Error(`Invalid ${fieldName}: must be a positive integer, got "${value}"`);
  }
  return n;
}

// ─── rate limiting ─────────────────────────────────────────────────────────────

const RATE_LIMIT = 50;
const TIME_WINDOW = 60;
const BAN_DURATION = 3600;

// in-memory rate limit cache — cloudflare reuses worker isolates within the same
// datacenter, so this map persists across requests on the same isolate. this cuts
// KV writes from "every request" down to "only on first-seen, ban, or window reset",
// which is critical on the free tier (1,000 KV writes/day limit).
// structure: ip → { count, windowStart, banned, banExpiry }
const rateLimitCache = new Map();

// in-memory ip policy cache — avoids a KV read on every single request.
// the policy list changes rarely, so 30s staleness is fine.
// structure: { bans: [...], fetchedAt: unixSeconds }
let ipPolicyCache = null;
const IP_POLICY_CACHE_TTL = 30;

async function getIpPolicy(env) {
  const now = Math.floor(Date.now() / 1000);
  if (ipPolicyCache && (now - ipPolicyCache.fetchedAt) < IP_POLICY_CACHE_TTL) {
    return ipPolicyCache.bans;
  }
  try {
    const policyData = await env.IP_BANS.get('ip_policy', { type: 'json' });
    const bans = (policyData && Array.isArray(policyData.bans)) ? policyData.bans : [];
    ipPolicyCache = { bans, fetchedAt: now };
    return bans;
  } catch (err) {
    console.error('Failed to fetch IP policy:', err);
    // return stale cache if available rather than an empty list, so a KV blip
    // doesn't suddenly un-ban everyone
    return ipPolicyCache ? ipPolicyCache.bans : [];
  }
}

function checkIpAgainstPolicy(ip, bansArray) {
  for (const entry of bansArray) {
    if (entry.ip === ip) return entry;
  }
  return null;
}

async function checkRateLimit(env, ip) {
  const key = `rate:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    // check in-memory cache first — avoids a KV read on every request
    let data = rateLimitCache.get(ip);

    if (!data) {
      // not in memory — check KV in case this isolate is fresh or the ip was
      // banned by a different isolate/datacenter
      const kvData = await env.IP_BANS.get(key, { type: 'json' });
      if (kvData) {
        data = kvData;
        rateLimitCache.set(ip, data);
      } else {
        // first ever request from this ip
        data = { count: 1, windowStart: now, banned: false, banExpiry: 0 };
        rateLimitCache.set(ip, data);
        // write to KV so other isolates know about this ip
        // TTL: just long enough to cover the window
        await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: TIME_WINDOW + 5 });
        return { allowed: true, data };
      }
    }

    if (data.banned) {
      if (now < data.banExpiry) {
        return { allowed: false, reason: 'banned', retryAfter: data.banExpiry - now };
      }
      // ban expired — reset
      data = { count: 1, windowStart: now, banned: false, banExpiry: 0 };
      rateLimitCache.set(ip, data);
      await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: TIME_WINDOW + 5 });
      return { allowed: true, data };
    }

    if (now - data.windowStart > TIME_WINDOW) {
      // window rolled over — reset counter, write to KV to sync other isolates
      data = { count: 1, windowStart: now, banned: false, banExpiry: 0 };
      rateLimitCache.set(ip, data);
      await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: TIME_WINDOW + 5 });
      return { allowed: true, data };
    }

    // still within window — increment in memory only, no KV write needed
    data.count++;
    rateLimitCache.set(ip, data);

    if (data.count > RATE_LIMIT) {
      data.banned = true;
      data.banExpiry = now + BAN_DURATION;
      rateLimitCache.set(ip, data);
      // ban must be written to KV so other isolates enforce it too
      await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: BAN_DURATION });
      return { allowed: false, reason: 'rate_limit_exceeded', retryAfter: BAN_DURATION };
    }

    return { allowed: true, data };
  } catch (error) {
    console.error('Rate limit check failed:', error);
    // fail open, but log it — if KV is broken we can't enforce bans anyway
    return { allowed: true, data: null };
  }
}

// ─── clearance cookie helper ───────────────────────────────────────────────────

// FIX: extracted cookie reading into a helper so it can be used in the main handler.
// previously the clearance token was written to KV but never read anywhere — the
// entire challenge system was a no-op. this function reads the cf_clearance cookie
// and verifies it against KV.
function getClearanceCookie(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)cf_clearance=([^;]+)/);
  return match ? match[1] : null;
}

async function isClearanceValid(env, token) {
  if (!token) return false;
  try {
    const entry = await env.IP_BANS.get(`clearance:${token}`, { type: 'json' });
    return entry !== null;
  } catch {
    return false;
  }
}

// ─── main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {

    // preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    // ── /verify-challenge ────────────────────────────────────────────────────
    if (url.pathname === "/verify-challenge") {
      if (request.method !== "POST") {
        return corsify(new Response("Method not allowed", { status: 405 }));
      }

      // FIX: /verify-challenge was handled before rate limiting ran, meaning it
      // was completely unprotected. check rate limit here explicitly.
      const challengeIP =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For") ||
        null;
      if (!challengeIP) {
        return corsify(new Response(
          JSON.stringify({ error: "Could not determine client IP" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ));
      }
      const challengeRate = await checkRateLimit(env, challengeIP);
      if (!challengeRate.allowed) {
        return corsify(Response.redirect('https://rblx-uif-site.pages.dev/blocked?type=temporary', 302));
      }

      try {
        const { token, returnUrl } = await request.json();

        // FIX: validate returnUrl is same-origin to prevent open redirect
        if (returnUrl) {
          let parsed;
          try {
            parsed = new URL(returnUrl, request.url);
          } catch {
            return corsify(new Response('Invalid returnUrl', { status: 400 }));
          }
          const requestOrigin = new URL(request.url).origin;
          if (parsed.origin !== requestOrigin) {
            return corsify(new Response('returnUrl must be same-origin', { status: 400 }));
          }
        }

        const secretKey = env.TURNSTILE_SECRET;
        const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`
        });
        const outcome = await verifyResponse.json();
        console.log('Turnstile outcome:', JSON.stringify(outcome));

        if (outcome.success) {
          const clearanceToken = crypto.randomUUID();
          await env.IP_BANS.put(
            `clearance:${clearanceToken}`,
            JSON.stringify({ createdAt: Date.now() }),
            { expirationTtl: 3600 }
          );

          const safeReturn = returnUrl || '/';
          const redirectResponse = new Response(null, {
            status: 302,
            headers: { 'Location': safeReturn }
          });
          redirectResponse.headers.append(
            'Set-Cookie',
            `cf_clearance=${clearanceToken}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`
          );
          return corsify(redirectResponse);
        } else {
          return corsify(new Response('Verification failed', { status: 403 }));
        }
      } catch (err) {
        return corsify(new Response('Invalid request', { status: 400 }));
      }
    }

    // ── ip / rate limiting ───────────────────────────────────────────────────

    // FIX: reject requests with no resolvable IP instead of bucketing them all
    // under "unknown" in KV. in a deployed cloudflare worker CF-Connecting-IP is
    // always injected, so its absence is a strong signal something is wrong.
    const clientIP =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For") ||
      null;

    if (!clientIP) {
      return corsify(new Response(
        JSON.stringify({ error: "Could not determine client IP" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      ));
    }

    const bans = await getIpPolicy(env);
    const policyMatch = checkIpAgainstPolicy(clientIP, bans);

    if (policyMatch) {
      const action = policyMatch.action || 'block';
      if (action === 'block') {
        return corsify(Response.redirect('https://rblx-uif-site.pages.dev/blocked?type=permanent', 302));
      } else if (action === 'challenge') {
        // FIX: before redirecting to the challenge page, check if the client already
        // has a valid clearance cookie. if they do, let them through — otherwise the
        // challenge loop is infinite for clients that have already completed it.
        const clearanceToken = getClearanceCookie(request);
        const cleared = await isClearanceValid(env, clearanceToken);
        if (!cleared) {
          const returnUrl = encodeURIComponent(request.url);
          return corsify(Response.redirect(`https://rblx-uif-site.pages.dev/challenge?return=${returnUrl}`, 302));
        }
        // valid clearance — fall through to normal handling
      } else if (action === 'allow') {
        // explicitly allowed, fall through
      } else {
        return corsify(new Response(JSON.stringify({
          error: "Access denied (unknown policy action).",
          reason: `IP matched policy with unknown action: ${action}`,
          action
        }), { status: 403, headers: { "Content-Type": "application/json" } }));
      }
    }

    if (url.pathname !== "/health" && !url.pathname.startsWith("/docs/")) {
      const rateCheck = await checkRateLimit(env, clientIP);
      if (!rateCheck.allowed) {
        return corsify(Response.redirect('https://rblx-uif-site.pages.dev/blocked?type=temporary', 302));
      }
    }

    // ── /health ──────────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      return corsify(new Response("OK", { status: 200 }));
    }

    // ── browser redirect ─────────────────────────────────────────────────────
    if (request.method === "GET") {
      const userAgent = request.headers.get("User-Agent") || "";
      if (isBrowser(userAgent)) {
        return corsify(Response.redirect("https://rblx-uif-site.pages.dev", 302));
      }
    }

    // FIX: method guard moved before the geometry dash easter egg check.
    // previously a GD client sending DELETE/PUT/etc would get the funny json
    // instead of a proper 405.
    if (request.method !== "POST") {
      return corsify(new Response(
        JSON.stringify({ error: "Check if you're not using POST." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      ));
    }

    // ── geometry dash easter egg ─────────────────────────────────────────────
    const userAgent = request.headers.get("User-Agent") || "";
    if (userAgent.toLowerCase().includes("geometrydash")) {
      return corsify(new Response(
        JSON.stringify({
          whatTheActualFuckBroQuestionMarkQuestionMark: "are you fucking launching this from GEOMETRY DASH????"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ));
    }

    // ── main roblox user info logic ──────────────────────────────────────────
    try {
      const body = await parseBody(request);

      // FIX: userId and groupId are sanitized to safe positive integers
      let userId = sanitizeRobloxId(body.userId, 'userId');
      const groupId = sanitizeRobloxId(body.groupId, 'groupId');
      const username = typeof body.username === 'string' ? body.username.trim() : null;

      // FIX: normalizeBoolean now throws on invalid input, wrapped in try/catch
      let includeAvatar, includePresence, includeFriendsCount,
          includeFollowersCount, includeFollowingCount, includeGroups;
      try {
        includeAvatar          = normalizeBoolean(body.includeAvatar, false);
        includePresence        = normalizeBoolean(body.includePresence, false);
        includeFriendsCount    = normalizeBoolean(body.includeFriendsCount, false);
        includeFollowersCount  = normalizeBoolean(body.includeFollowersCount, false);
        includeFollowingCount  = normalizeBoolean(body.includeFollowingCount, false);
        includeGroups          = normalizeBoolean(body.includeGroups, true);
      } catch (boolErr) {
        return corsify(new Response(
          JSON.stringify({ error: boolErr.message }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ));
      }

      // resolve username → userId
      if (!userId && username) {
        const userRes = await fetch("https://users.roproxy.com/v1/usernames/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
        });
        const userData = await userRes.json();
        if (!userRes.ok) {
          return corsify(new Response(
            JSON.stringify({
              error: "Failed to fetch username lookup",
              apiStatusCode: userRes.status,
              requestedUsername: username,
              apiResponse: userData
            }),
            { status: userRes.status, headers: { "Content-Type": "application/json" } }
          ));
        }
        if (userData.data && userData.data.length > 0) {
          userId = userData.data[0].id;
        } else {
          return corsify(new Response(
            JSON.stringify({
              error: "User not found",
              requestedUsername: username,
              apiResponse: userData
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          ));
        }
      }

      if (!userId) {
        return corsify(new Response(
          JSON.stringify({ error: "No userId or username provided" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ));
      }

      const profileRes = await fetch(`https://users.roproxy.com/v1/users/${userId}`);
      if (!profileRes.ok) {
        return corsify(new Response(
          JSON.stringify({ error: "Failed to fetch user profile" }),
          { status: profileRes.status, headers: { "Content-Type": "application/json" } }
        ));
      }
      const profile = await profileRes.json();

      // build parallel fetch list
      const promises = [];
      const promiseKeys = [];

      if (includeGroups) {
        promises.push(fetch(`https://groups.roproxy.com/v1/users/${userId}/groups/roles`));
        promiseKeys.push('groups');
      }
      if (includeAvatar) {
        promises.push(fetch(`https://thumbnails.roproxy.com/v1/users/avatar-headshot?userIds=${userId}&size=720x720&format=Png`));
        promiseKeys.push('avatar');
      }
      if (includePresence) {
        promises.push(fetch(`https://presence.roproxy.com/v1/presence/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: [userId] })
        }));
        promiseKeys.push('presence');
      }
      if (includeFriendsCount) {
        promises.push(fetch(`https://friends.roproxy.com/v1/users/${userId}/friends/count`));
        promiseKeys.push('friendsCount');
      }
      if (includeFollowersCount) {
        promises.push(fetch(`https://friends.roproxy.com/v1/users/${userId}/followers/count`));
        promiseKeys.push('followersCount');
      }
      if (includeFollowingCount) {
        promises.push(fetch(`https://friends.roproxy.com/v1/users/${userId}/followings/count`));
        promiseKeys.push('followingCount');
      }

      const rawResults = await Promise.allSettled(promises);

      const jsonResults = await Promise.all(
        rawResults.map(async (result, index) => {
          if (result.status === 'fulfilled') {
            try {
              const data = await result.value.json();
              return { key: promiseKeys[index], data };
            } catch {
              // FIX: cancel body stream on fulfilled-but-unparseable responses to
              // avoid holding open readable streams that weren't previously cleaned up.
              // the rejected-fetch cancel below only covered network failures, not
              // cases where the fetch succeeded but the body was malformed json.
              try { result.value?.body?.cancel(); } catch {}
              return null;
            }
          } else {
            // FIX: cancel unread response bodies from rejected fetches to avoid
            // memory pressure from unconsumed streams in the worker
            try { result.value?.body?.cancel(); } catch {}
            return null;
          }
        })
      );

      let groupsData = null, avatarData = null, presenceData = null;
      let friendsCountData = null, followersCountData = null, followingCountData = null;

      for (const item of jsonResults) {
        if (!item) continue;
        switch (item.key) {
          case 'groups':        groupsData        = item.data; break;
          case 'avatar':        avatarData        = item.data; break;
          case 'presence':      presenceData      = item.data; break;
          case 'friendsCount':  friendsCountData  = item.data; break;
          case 'followersCount':followersCountData = item.data; break;
          case 'followingCount':followingCountData = item.data; break;
        }
      }

      // build response
      const response = {
        id: profile.id,
        username: profile.name,
        displayName: profile.displayName,
        created: profile.created,
        profileUrl: `https://www.roproxy.com/users/${profile.id}/profile`,
      };

      if (profile.description) response.description = profile.description;

      if (includeGroups && groupsData) {
        response.groups = groupsData.data.map(g => ({
          groupId: g.group.id,
          groupName: g.group.name,
          memberCount: g.group.memberCount,
          roleId: g.role.id,
          roleName: g.role.name,
          rank: g.role.rank,
        }));

        if (groupId) {
          const groupMatch = groupsData.data.find(g => g.group.id === groupId);
          response.requestedGroup = groupMatch ? {
            groupId: groupMatch.group.id,
            groupName: groupMatch.group.name,
            roleId: groupMatch.role.id,
            roleName: groupMatch.role.name,
            rank: groupMatch.role.rank,
          } : null;
        }
      }

      if (includeAvatar && avatarData?.data) {
        response.avatarUrl = avatarData.data[0]?.imageUrl || null;
      }

      // FIX: guard against empty userPresences array before accessing [0]
      if (includePresence && presenceData?.userPresences?.length > 0) {
        const presence = presenceData.userPresences[0];
        response.presence = {
          userPresenceType: presence.userPresenceType,
          lastLocation: presence.lastLocation,
          placeId: presence.placeId,
          rootPlaceId: presence.rootPlaceId,
          gameId: presence.gameId,
          universeId: presence.universeId
        };
      }

      if (includeFriendsCount && friendsCountData) {
        response.friendsCount = friendsCountData.count;
      }
      if (includeFollowersCount && followersCountData) {
        response.followersCount = followersCountData.count;
      }
      if (includeFollowingCount && followingCountData) {
        response.followingCount = followingCountData.count;
      }

      return corsify(new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" }
      }));

    } catch (err) {
      // FIX: previously this returned 400 for everything, including upstream failures
      // which are clearly not the caller's fault. now distinguishes client errors
      // (validation, bad input) from server/upstream errors.
      const isClientError = err instanceof SyntaxError || err.message?.includes('Invalid ') || err.message?.includes('Unsupported content type');
      return corsify(new Response(JSON.stringify({ error: "Worker Error", detail: err.message }), {
        status: isClientError ? 400 : 502,
        headers: { "Content-Type": "application/json" }
      }));
    }
  }
};
