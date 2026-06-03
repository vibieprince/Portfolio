// api/github.js

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=14400, stale-while-revalidate"
  );

  const username = "vibieprince";

  const query = `
  query {
    user(login: "${username}") {

      followers {
        totalCount
      }

      following {
        totalCount
      }

      repositories(
        first: 100,
        ownerAffiliations: OWNER
      ) {
        totalCount

        nodes {
          stargazerCount
        }
      }

      contributionsCollection {
        contributionCalendar {
          totalContributions
        }
      }

      pullRequests {
        totalCount
      }
    }
  }
  `;

  try {
    const response = await fetch(
      "https://api.github.com/graphql",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          query
        })
      }
    );

    if (!response.ok) {
      throw new Error(
        `GitHub GraphQL Error: ${response.status}`
      );
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(
        JSON.stringify(result.errors)
      );
    }

    const user = result.data.user;

    const totalStars =
      user.repositories.nodes.reduce(
        (sum, repo) =>
          sum + repo.stargazerCount,
        0
      );

    res.status(200).json({
      public_repos:
        user.repositories.totalCount,

      followers:
        user.followers.totalCount,

      following:
        user.following.totalCount,

      total_commits:
        user.contributionsCollection
          .contributionCalendar
          .totalContributions,

      pull_requests:
        user.pullRequests.totalCount,

      stars:
        totalStars,

      success: true
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });

  }
}