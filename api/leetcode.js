// api/leetcode.js
export default async function handler(req, res) {
  // Instruct Vercel edge routers to cache data for 4 hours to maximize performance
  res.setHeader('Cache-Control', 's-maxage=14400, stale-while-revalidate');
  
  const username = "vibieprince";
  const query = `
    query userProblemsSolved($username: String!) {
      allQuestionsCount { difficulty count }
      matchedUser(username: $username) {
        profile { ranking }
        submitStats {
          acSubmissionNum { difficulty count }
        }
      }
    }
  `;

  try {
    const response = await fetch("https://leetcode.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { username } }),
    });

    if (!response.ok) throw new Error("LeetCode core gateway unreachable");
    const result = await response.json();
    
    if (result.errors || !result.data.matchedUser) {
      return res.status(404).json({ status: "error", message: "Profile context invalid" });
    }

    const data = result.data;
    const totalQuestions = data.allQuestionsCount || [];
    const submitStats = data.matchedUser.submitStats.acSubmissionNum || [];
    const ranking = data.matchedUser.profile.ranking || 0;

    const findCount = (arr, diff) => (arr.find(x => x.difficulty === diff) || { count: 0 }).count;

    return res.status(200).json({
      status: "success",
      totalSolved: findCount(submitStats, "All"),
      ranking: ranking,
      easySolved: findCount(submitStats, "Easy"),
      totalEasy: findCount(totalQuestions, "Easy"),
      mediumSolved: findCount(submitStats, "Medium"),
      totalMedium: findCount(totalQuestions, "Medium"),
      hardSolved: findCount(submitStats, "Hard"),
      totalHard: findCount(totalQuestions, "Hard")
    });
  } catch (error) {
    return res.status(500).json({ status: "error", message: error.message });
  }
}