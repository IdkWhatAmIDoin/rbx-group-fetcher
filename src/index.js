function corsify(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

async function updateStats(env, type = 'request') {
  const today = new Date().toISOString().slice(0, 10);
  const totalKey = 'stats_total';
  const dailyKey = `stats_daily_${today}`;
  let total = await env.STATS.get(totalKey, { type: 'json' }) || { totalRequests: 0, successfulRequests: 0, bannedRequests: 0 };
  total.totalRequests++;
  if (type === 'success') total.successfulRequests++;
  if (type === 'ban') total.bannedRequests++;
  await env.STATS.put(totalKey, JSON.stringify(total));
  let daily = await env.STATS.get(dailyKey, { type: 'json' }) || { totalRequests: 0, successfulRequests: 0, bannedRequests: 0, date: today };
  daily.totalRequests++;
  if (type === 'success') daily.successfulRequests++;
  if (type === 'ban') daily.bannedRequests++;
  await env.STATS.put(dailyKey, JSON.stringify(daily), { expirationTtl: 86400 * 30 });
}
function isBrowser(userAgent) {
  const browserPatterns = [
    "Mozilla", "Chrome", "Safari", "Edge", "Opera",
    "MSIE", "Trident", "Firefox"
  ];
  return browserPatterns.some(pattern => userAgent.includes(pattern));
}

async function parseBody(request) {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await request.json();
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
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

function normalizeBoolean(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === '1' || lower === 'on') return true;
    if (lower === 'false' || lower === '0' || lower === 'off') return false;
  }
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}

const RATE_LIMIT = 50;
const TIME_WINDOW = 60;
const BAN_DURATION = 3600;

async function getIpPolicy(env) {
  try {
    const policyData = await env.IP_BANS.get('ip_policy', { type: 'json' });
    return (policyData && Array.isArray(policyData.bans)) ? policyData.bans : [];
  } catch (err) {
    console.error('Failed to fetch IP policy:', err);
    return [];
  }
}

function checkIpAgainstPolicy(ip, bansArray) {
  for (const entry of bansArray) {
    if (entry.ip === ip) {
      return entry; 
    }
  }
  return null;
}
async function checkRateLimit(env, ip) {
  const key = `rate:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    let data = await env.IP_BANS.get(key, { type: 'json' });
    if (!data) {
      data = {
        count: 1,
        windowStart: now,
        banned: false,
        banExpiry: 0
      };
      await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: BAN_DURATION });
      return { allowed: true, data };
    }
    if (data.banned) {
      if (now < data.banExpiry) {
        return { 
          allowed: false, 
          reason: 'banned', 
          retryAfter: data.banExpiry - now 
        };
      } else {
        data = {
          count: 1,
          windowStart: now,
          banned: false,
          banExpiry: 0
        };
        await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: BAN_DURATION });
        return { allowed: true, data };
      }
    }
    if (now - data.windowStart > TIME_WINDOW) {
      data = {
        count: 1,
        windowStart: now,
        banned: false,
        banExpiry: 0
      };
    } else {
      data.count++;
    }
    if (data.count > RATE_LIMIT) {
      data.banned = true;
      data.banExpiry = now + BAN_DURATION;
      await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: BAN_DURATION });
      return { 
        allowed: false, 
        reason: 'rate_limit_exceeded', 
        retryAfter: BAN_DURATION 
      };
    }
    await env.IP_BANS.put(key, JSON.stringify(data), { expirationTtl: BAN_DURATION });
    return { allowed: true, data };
  } catch (error) {
    console.error('Rate limit check failed:', error);
    return { allowed: true, data: null };
  }
}

export default {
  async fetch(request, env) {
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
    if (url.pathname === "/verify-challenge") {
        if (request.method !== "POST") {
          return corsify(new Response("Method not allowed", { status: 405 }));
        }
      try {
        const { token, returnUrl } = await request.json();
        const secretKey = env.TURNSTILE_SECRET;
        const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`
        });
        const outcome = await verifyResponse.json();

        console.log('Turnstile outcome:', JSON.stringify(outcome));
        
        if (outcome.success) {
          const response = corsify(new Response(null, {
            status: 302,
            headers: { 'Location': returnUrl || '/' }
          }));
          response.headers.append('Set-Cookie', `cf_clearance=${crypto.randomUUID()}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax`);
          return corsify(response);
        } else {
          return corsify(new Response('Verification failed', { status: 403 }));
        }
      } catch (err) {
        return corsify(new Response('Invalid request', { status: 400 }));
      }
    }
    if (url.pathname === "/api/stats") {
      const today = new Date().toISOString().slice(0, 10);
      const totalKey = 'stats_total';
      const dailyKey = `stats_daily_${today}`;
  
      const total = await env.STATS.get(totalKey, { type: 'json' }) || { totalRequests: 0, successfulRequests: 0, bannedRequests: 0 };
      const daily = await env.STATS.get(dailyKey, { type: 'json' }) || { totalRequests: 0, successfulRequests: 0, bannedRequests: 0, date: today };

      return corsify(new Response(JSON.stringify({ total, daily }), {
        headers: { "Content-Type": "application/json" }
      }));
    }
    const clientIP = request.headers.get("CF-Connecting-IP") || 
                     request.headers.get("X-Forwarded-For") || 
                     "unknown";
    await updateStats(env, 'request');
    const bans = await getIpPolicy(env);
    const policyMatch = checkIpAgainstPolicy(clientIP, bans);
    
    if (policyMatch) {
      const action = policyMatch.action || 'block';
      switch (action) {
        case 'block':
          return corsify(Response.redirect(
            'https://rblx-uif-site.pages.dev/blocked?type=permanent',
            302
          ));

        case 'challenge':
          const returnUrl = encodeURIComponent(request.url);
          return corsify(Response.redirect(
            `https://rblx-uif-site.pages.dev/challenge?return=${returnUrl}`,
            302
          ));
        case 'allow':
          break;

        default:
          return corsify(new Response(JSON.stringify({
            error: "Access denied (unknown policy action).",
            reason: `IP matched policy with unknown action: ${action}`,
            action: action
          }), { status: 403 }));
      }
    }
    if (url.pathname !== "/health" && !url.pathname.startsWith("/docs/")) {
      const rateCheck = await checkRateLimit(env, clientIP);
      if (!rateCheck.allowed) {
        return corsify(Response.redirect(
          'https://rblx-uif-site.pages.dev/blocked?type=temporary',
          302
        ));
      }
    }
    if (url.pathname === "/health") {
      return corsify(new Response("OK", { status: 200 }));
    }
    if (request.method === "GET") {
      const userAgent = request.headers.get("User-Agent") || "";
      if (isBrowser(userAgent)) {
        return corsify(Response.redirect("https://rblx-uif-site.pages.dev", 302));
      }
    }

    const userAgent = request.headers.get("User-Agent") || "";
    if (userAgent.toLowerCase().includes("geometrydash")) {
      return corsify(new Response(
        JSON.stringify({
          whatTheActualFuckBroQuestionMarkQuestionMark: "are you fucking launching this from GEOMETRY DASH????"
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ));
    }
    if (request.method !== "POST") {
      return corsify(new Response(
        JSON.stringify({ error: "Check if you're not using POST." }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      ));
    }
    try {
      const body = await parseBody(request);
      let userId = body.userId;
      const username = body.username;
      const groupId = body.groupId;

      const includeAvatar = normalizeBoolean(body.includeAvatar, false);
      const includePresence = normalizeBoolean(body.includePresence, false);
      const includeFriendsCount = normalizeBoolean(body.includeFriendsCount, false);
      const includeFollowersCount = normalizeBoolean(body.includeFollowersCount, false);
      const includeFollowingCount = normalizeBoolean(body.includeFollowingCount, false);
      const includeGroups = normalizeBoolean(body.includeGroups, true);

      if (!userId && username) {
        const userRes = await fetch("https://users.roblox.com/v1/usernames/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
        });
        const userData = await userRes.json();
        if (userData.data && userData.data.length > 0) {
          userId = userData.data[0].id;
        } else {
          return corsify(new Response(
            JSON.stringify({ error: "Username not found on Roblox" }),
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

      const profileRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
      if (!profileRes.ok) {
        return corsify(new Response(
          JSON.stringify({ error: "Failed to fetch user profile" }),
          { status: profileRes.status, headers: { "Content-Type": "application/json" } }
        ));
      }
      const profile = await profileRes.json();

      const promises = [];
      const promiseKeys = [];

      if (includeGroups) {
        promises.push(fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`));
        promiseKeys.push('groups');
      }
      if (includeAvatar) {
        promises.push(fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=720x720&format=Png`));
        promiseKeys.push('avatar');
      }
      if (includePresence) {
        promises.push(fetch(`https://presence.roblox.com/v1/presence/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds: [userId] })
        }));
        promiseKeys.push('presence');
      }
      if (includeFriendsCount) {
        promises.push(fetch(`https://friends.roblox.com/v1/users/${userId}/friends/count`));
        promiseKeys.push('friendsCount');
      }
      if (includeFollowersCount) {
        promises.push(fetch(`https://friends.roblox.com/v1/users/${userId}/followers/count`));
        promiseKeys.push('followersCount');
      }
      if (includeFollowingCount) {
        promises.push(fetch(`https://friends.roblox.com/v1/users/${userId}/followings/count`));
        promiseKeys.push('followingCount');
      }

      const results = await Promise.allSettled(promises);
      let groupsData = null, avatarData = null, presenceData = null;
      let friendsCountData = null, followersCountData = null, followingCountData = null;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const key = promiseKeys[index];
          result.value.json().then(data => {
            switch (key) {
              case 'groups': groupsData = data; break;
              case 'avatar': avatarData = data; break;
              case 'presence': presenceData = data; break;
              case 'friendsCount': friendsCountData = data; break;
              case 'followersCount': followersCountData = data; break;
              case 'followingCount': followingCountData = data; break;
            }
          }).catch(() => {});
        }
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = {
        id: profile.id,
        username: profile.name,
        displayName: profile.displayName,
        created: profile.created,
        profileUrl: `https://www.roblox.com/users/${profile.id}/profile`,
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
          isPrimary: g.isPrimaryGroup
        }));

        if (groupId) {
          const groupMatch = groupsData.data.find(g => g.group.id === parseInt(groupId));
          response.requestedGroup = groupMatch ? {
            groupId: groupMatch.group.id,
            groupName: groupMatch.group.name,
            roleId: groupMatch.role.id,
            roleName: groupMatch.role.name,
            rank: groupMatch.role.rank,
            isPrimary: groupMatch.isPrimaryGroup
          } : null;
        }
      }

      if (includeAvatar && avatarData && avatarData.data) {
        response.avatarUrl = avatarData.data[0]?.imageUrl || null;
      }

      if (includePresence && presenceData && presenceData.userPresences) {
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
      return corsify(new Response(JSON.stringify({ error: "Worker Error", detail: err.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      }));
    }
  }
};
