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

        pullRequests {
          totalCount
        }

        contributionsCollection {
          contributionCalendar {
            totalContributions
          }
        }

        repositories(
          first: 100,
          ownerAffiliations: OWNER,
          orderBy: {
            field: STARGAZERS,
            direction: DESC
          }
        ) {
          totalCount

          nodes {
            name

            url

            stargazerCount

            forkCount

            primaryLanguage {
              name
            }
          }
        }
      }
    }
  `;

  try {
    const githubResponse = await fetch(
      "https://api.github.com/graphql",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ query })
      }
    );

    if (!githubResponse.ok) {
      throw new Error(
        `GitHub GraphQL Error: ${githubResponse.status}`
      );
    }

    const result = await githubResponse.json();

    if (result.errors) {
      throw new Error(
        JSON.stringify(result.errors, null, 2)
      );
    }

    const user = result?.data?.user;

    if (!user) {
      throw new Error("GitHub user not found");
    }

    const repositories = user.repositories.nodes || [];

    const totalStars = repositories.reduce(
      (sum, repo) => sum + repo.stargazerCount,
      0
    );

    const topRepositories = repositories
      .sort((a, b) => {
        if (
          b.stargazerCount !== a.stargazerCount
        ) {
          return (
            b.stargazerCount -
            a.stargazerCount
          );
        }

        return b.forkCount - a.forkCount;
      })
      .slice(0, 3)
      .map((repo) => ({
        name: repo.name,
        html_url: repo.url,
        stargazers_count:
          repo.stargazerCount,
        language:
          repo.primaryLanguage?.name ||
          "JavaScript"
      }));

    const responsePayload = {
      success: true,

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

      total_prs:
        user.pullRequests.totalCount,

      stars: totalStars,

      top_repositories:
        topRepositories
    };

    return res
      .status(200)
      .json(responsePayload);

  } catch (error) {
    console.error(
      "GitHub API Error:",
      error
    );

    return res.status(500).json({
      success: false,
      public_repos: 0,
      followers: 0,
      following: 0,
      total_commits: 0,
      total_prs: 0,
      stars: 0,
      top_repositories: [],
      error: error.message
    });
  }
}