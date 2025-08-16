import { query } from "./_generated/server";
import { v } from "convex/values";

// Query: Get users with unresolved 1-to-1 debts
export const getUsersWithOutstandingDebts = query({
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const result = [];

    // Fetch 1-to-1 expenses (no groupId)
    const expenses = await ctx.db
      .query("expenses")
      .filter((q) => q.eq(q.field("groupId"), undefined))
      .collect();

    // Fetch 1-to-1 settlements (no groupId)
    const settlements = await ctx.db
      .query("settlements")
      .filter((q) => q.eq(q.field("groupId"), undefined))
      .collect();

    // Cache user lookups
    const userCache = new Map();
    const getUser = async (id) => {
      if (!userCache.has(id)) userCache.set(id, await ctx.db.get(id));
      return userCache.get(id);
    };

    for (const user of users) {
      // Ledger: maps counterparty → balance
      const ledger = new Map();

      // Step 1: Apply all expenses
      for (const exp of expenses) {
        // Case A: User owes someone
        if (exp.paidByUserId !== user._id) {
          const split = exp.splits.find(
            (s) => s.userId === user._id && !s.paid
          );
          if (!split) continue;

          const entry = ledger.get(exp.paidByUserId) ?? {
            amount: 0,
            since: exp.date,
          };
          entry.amount += split.amount;
          entry.since = Math.min(entry.since, exp.date);
          ledger.set(exp.paidByUserId, entry);
        }
        // Case B: Others owe user
        else {
          for (const s of exp.splits) {
            if (s.userId === user._id || s.paid) continue;

            const entry = ledger.get(s.userId) ?? {
              amount: 0,
              since: exp.date,
            };
            entry.amount -= s.amount;
            ledger.set(s.userId, entry);
          }
        }
      }

      // Step 2: Apply settlements
      for (const st of settlements) {
        // User paid someone
        if (st.paidByUserId === user._id) {
          const entry = ledger.get(st.receivedByUserId);
          if (entry) {
            entry.amount -= st.amount;
            if (entry.amount === 0) ledger.delete(st.receivedByUserId);
            else ledger.set(st.receivedByUserId, entry);
          }
        }
        // Someone paid user
        else if (st.receivedByUserId === user._id) {
          const entry = ledger.get(st.paidByUserId);
          if (entry) {
            entry.amount += st.amount;
            if (entry.amount === 0) ledger.delete(st.paidByUserId);
            else ledger.set(st.paidByUserId, entry);
          }
        }
      }

      // Step 3: Collect only outstanding positive debts
      const debts = [];
      for (const [counterId, { amount, since }] of ledger) {
        if (amount > 0) {
          const counter = await getUser(counterId);
          debts.push({
            userId: counterId,
            name: counter?.name ?? "Unknown",
            amount,
            since,
          });
        }
      }

      if (debts.length) {
        result.push({
          _id: user._id,
          name: user.name,
          email: user.email,
          debts,
        });
      }
    }

    return result;
  },
});

// Query: Get users with recent expenses (for AI insights)
export const getUsersWithExpenses = query({
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const result = [];

    // Get start of last month
    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(now.getMonth() - 1);
    const monthStart = oneMonthAgo.getTime();

    for (const user of users) {
      // Expenses paid by user
      const paidExpenses = await ctx.db
        .query("expenses")
        .withIndex("by_date", (q) => q.gte("date", monthStart))
        .filter((q) => q.eq(q.field("paidByUserId"), user._id))
        .collect();

      // Expenses where user is in splits
      const allRecentExpenses = await ctx.db
        .query("expenses")
        .withIndex("by_date", (q) => q.gte("date", monthStart))
        .collect();

      const splitExpenses = allRecentExpenses.filter((expense) =>
        expense.splits.some((split) => split.userId === user._id)
      );

      // Merge both lists
      const userExpenses = [...new Set([...paidExpenses, ...splitExpenses])];

      if (userExpenses.length > 0) {
        result.push({
          _id: user._id,
          name: user.name,
          email: user.email,
        });
      }
    }

    return result;
  },
});

// Query: Get a specific user's expenses for past month
export const getUserMonthlyExpenses = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Get start of last month
    const now = new Date();
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(now.getMonth() - 1);
    const monthStart = oneMonthAgo.getTime();

    // Get all expenses from past month
    const allExpenses = await ctx.db
      .query("expenses")
      .withIndex("by_date", (q) => q.gte("date", monthStart))
      .collect();

    // Filter expenses involving this user
    const userExpenses = allExpenses.filter((expense) => {
      const isInvolved =
        expense.paidByUserId === args.userId ||
        expense.splits.some((split) => split.userId === args.userId);
      return isInvolved;
    });

    // Shape response for AI analysis
    return userExpenses.map((expense) => {
      const userSplit = expense.splits.find(
        (split) => split.userId === args.userId
      );

      return {
        description: expense.description,
        category: expense.category,
        date: expense.date,
        amount: userSplit ? userSplit.amount : 0,
        isPayer: expense.paidByUserId === args.userId,
        isGroup: expense.groupId !== undefined,
      };
    });
  },
});
