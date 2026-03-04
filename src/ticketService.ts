import { Pool, PoolClient } from "pg";

interface TicketPool {
  event_id: string;
  total: number;
  available: number;
}

const pool = new Pool({
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

export async function purchaseTickets(
  userId: string,
  eventId: string,
  quantity: number,
): Promise<number[]> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const availableResult = await client.query<TicketPool>(
      "SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE",
      [eventId],
    );

    if (availableResult.rows.length === 0) {
      throw new Error("Event not found");
    }

    const ticketPool = availableResult.rows[0];

    if (!ticketPool || ticketPool.available < quantity) {
      throw new Error("Not enough tickets available");
    }

    const currentTotal = ticketPool.total - ticketPool.available;
    const ticketNumbers: number[] = [];

    for (let i = 0; i < quantity; i++) {
      const ticketNumber = currentTotal + i + 1;
      ticketNumbers.push(ticketNumber);
      await client.query(
        "INSERT INTO issued_tickets (event_id, user_id, ticket_number) VALUES ($1, $2, $3)",
        [eventId, userId, ticketNumber],
      );
    }

    await client.query(
      "UPDATE ticket_pools SET available = available - $1 WHERE event_id = $2",
      [quantity, eventId],
    );

    await client.query("COMMIT");
    return ticketNumbers;

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPool(): Promise<Pool> {
  return pool;
}
