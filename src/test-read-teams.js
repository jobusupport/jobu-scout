const { getTeamsFromGoogleSheet } = require("./read-teams-from-sheet");

async function main() {
  const teams = await getTeamsFromGoogleSheet();

  console.log("");
  console.log("Teams found:");
  console.log("============");

  for (const team of teams) {
    console.log(`Raw:            ${team.rawTeamName}`);
    console.log(`Clean:          ${team.teamName}`);
    console.log(`Classification: ${team.classification}`);
    console.log(`Age:            ${team.age}`);
    console.log(`From:           ${team.from}`);
    console.log(`City Alias:     ${team.city}`);
    console.log(`State:          ${team.state}`);
    console.log("");
  }

  console.log(`Total teams: ${teams.length}`);
}

main().catch((error) => {
  console.error("Failed to read teams from sheet:");
  console.error(error.message);
  process.exit(1);
});