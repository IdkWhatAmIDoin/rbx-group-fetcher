function corsify(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
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
export default {
  async fetch(request) {
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
    if (url.pathname === "/health") {
      return corsify(new Response("OK", { status: 200 }));
    }
    if (request.method === "GET") {
      const userAgent = request.headers.get("User-Agent") || "";
      if (isBrowser(userAgent)) {
        return corsify(Response.redirect("https://rblx-uif-site.pages.dev", 302));
      main
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
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
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
