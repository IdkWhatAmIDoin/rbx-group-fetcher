export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
    }

    try {
      const body = await request.json();
      let userId = body.userId;
      const username = body.username;
      const groupId = body.groupId;
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

      const [profileRes, groupsRes] = await Promise.all([
        fetch(`https://users.roblox.com/v1/users/${userId}`),
        fetch(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)
      ]);

      const profile = await profileRes.json();
      const groupsData = await groupsRes.json();

      const groupMatch = groupId 
        ? groupsData.data.find(g => g.group.id === parseInt(groupId)) 
        : null;

      return new Response(JSON.stringify({
        id: profile.id,
        username: profile.name,
        rank: groupMatch ? groupMatch.role.rank : 0,
        role: groupMatch ? groupMatch.role.name : "Guest"
      }), { headers: { "Content-Type": "application/json" } });

    } catch (err) {
      return new Response(JSON.stringify({ error: "Worker Error", detail: err.message }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }
}

