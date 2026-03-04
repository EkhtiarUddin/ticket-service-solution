const axios = require("axios");

const BASE_URL = "http://localhost:3000";
const EVENT_ID = "EVENT004";
const CONCURRENT_USERS = 20;
const TICKETS_PER_USER = 8;

async function purchaseTickets(userId) {
  try {
    const res = await axios.post(`${BASE_URL}/purchase`, {
      userId,
      eventId: EVENT_ID,
      quantity: TICKETS_PER_USER,
    });
    return { userId, success: true, tickets: res.data.tickets };
  } catch (err) {
    return {
      userId,
      success: false,
      error: err.response?.data?.error || err.message,
    };
  }
}

async function main() {
  console.log("=== BUG REPRODUCTION SCRIPT ===");
  console.log(`Firing ${CONCURRENT_USERS} simultaneous requests, ${TICKETS_PER_USER} tickets each\n`);

  const promises = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
    purchaseTickets(`user_${i + 1}`)
  );
  const results = await Promise.all(promises);

  const successful = results.filter((r) => r.success);
  const allTickets = successful.flatMap((r) => r.tickets);
  const uniqueTickets = new Set(allTickets);

  console.log(`Successful purchases: ${successful.length}`);
  console.log(`Total tickets issued: ${allTickets.length}`);
  console.log(`Unique ticket numbers: ${uniqueTickets.size}`);

  if (allTickets.length !== uniqueTickets.size) {
    const duplicates = allTickets.filter((t, i) => allTickets.indexOf(t) !== i);
    console.log(`\nBUG #2 CONFIRMED — DUPLICATE TICKET NUMBERS!`);
    console.log(`Duplicate numbers: ${[...new Set(duplicates)].join(", ")}`);
  }

  console.log(`\nIndividual results:`);
  results.forEach((r) => {
    if (r.success) {
      console.log(`  ${r.userId}: tickets ${r.tickets[0]}–${r.tickets[r.tickets.length - 1]}`);
    } else {
      console.log(`  ${r.userId}: FAILED — ${r.error}`);
    }
  });
}

main().catch(console.error);
