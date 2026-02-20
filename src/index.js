export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Are you in a browser? Otherwise, check if you're not using POST." }), { status: 405 });
    }

    try {
      const body = await request.json();
      let userId = body.userId;
      const username = body.username;
      const groupId = body.groupId;
      // optional rquest body fields
      const includeAvatar = body.includeAvatar || false;
      const includePresence = body.includePresence || false;
      const includeFriendsCount = body.includeFriendsCount || false;
      const includeFollowersCount = body.includeFollowersCount || false;
      const includeFollowingCount = body.includeFollowingCount || false;
      const includeGroups = body.includeGroups !== false;
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
          return new Response(JSON.stringify({ error: "Username not found on Roblox" }), { status: 404 });
        }
      }

      if (!userId) {
        return new Response(JSON.stringify({ error: "No userId or username provided" }), { status: 400 });
      }
      const profileRes = await fetch(`https://users.roblox.com/v1/users/${userId}`);
      if (!profileRes.ok) {
        return new Response(JSON.stringify({ error: "Failed to fetch user profile" }), { status: profileRes.status });
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
      let groupsData = null;
      let avatarData = null;
      let presenceData = null;
      let friendsCountData = null;
      let followersCountData = null;
      let followingCountData = null;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const key = promiseKeys[index];
          result.value.json().then(data => {
            switch(key) {
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

      return new Response(JSON.stringify(response), { 
        headers: { "Content-Type": "application/json" } 
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker Error", detail: err.message }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }
}
