import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Create a new expense
export const createExpense = mutation({
  args: {
    description: v.string(),
    amount: v.number(),
    category: v.optional(v.string()),
    date: v.number(), // timestamp
    paidByUserId: v.id("users"),
    splitType: v.string(), // "equal" | "percentage" | "exact"
    splits: v.array(
      v.object({
        userId: v.id("users"),
        amount: v.number(),
        paid: v.boolean(),
      })
    ),
    groupId: v.optional(v.id("groups")),
  },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);

    // Validate group membership if groupId provided
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group) throw new Error("Group not found");
      const isMember = group.members.some((m) => m.userId === user._id);
      if (!isMember) throw new Error("You are not a member of this group");
    }

    // Ensure splits sum to total (tolerance for float errors)
    const totalSplit = args.splits.reduce((sum, s) => sum + s.amount, 0);
    if (Math.abs(totalSplit - args.amount) > 0.01) {
      throw new Error("Split amounts must equal total expense");
    }

    // Insert expense
    return await ctx.db.insert("expenses", {
      description: args.description,
      amount: args.amount,
      category: args.category || "Other",
      date: args.date,
      paidByUserId: args.paidByUserId,
      splitType: args.splitType,
      splits: args.splits,
      groupId: args.groupId,
      createdBy: user._id,
    });
  },
});

// Get all expenses between current user and another user
export const getExpensesBetweenUsers = query({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const me = await ctx.runQuery(internal.users.getCurrentUser);
    if (me._id === userId) throw new Error("Cannot query yourself");

    // Expenses where either user is payer (no group)
    const myPaid = await ctx.db
      .query("expenses")
      .withIndex("by_user_and_group", (q) =>
        q.eq("paidByUserId", me._id).eq("groupId", undefined)
      )
      .collect();

    const theirPaid = await ctx.db
      .query("expenses")
      .withIndex("by_user_and_group", (q) =>
        q.eq("paidByUserId", userId).eq("groupId", undefined)
      )
      .collect();

    const candidateExpenses = [...myPaid, ...theirPaid];

    // Keep only expenses where both users are involved
    const expenses = candidateExpenses.filter((e) => {
      const meInSplits = e.splits.some((s) => s.userId === me._id);
      const themInSplits = e.splits.some((s) => s.userId === userId);
      return (
        (e.paidByUserId === me._id || meInSplits) &&
        (e.paidByUserId === userId || themInSplits)
      );
    });

    expenses.sort((a, b) => b.date - a.date);

    // Fetch settlements between users (no group)
    const settlements = await ctx.db
      .query("settlements")
      .filter((q) =>
        q.and(
          q.eq(q.field("groupId"), undefined),
          q.or(
            q.and(
              q.eq(q.field("paidByUserId"), me._id),
              q.eq(q.field("receivedByUserId"), userId)
            ),
            q.and(
              q.eq(q.field("paidByUserId"), userId),
              q.eq(q.field("receivedByUserId"), me._id)
            )
          )
        )
      )
      .collect();

    settlements.sort((a, b) => b.date - a.date);

    // Compute running balance
    let balance = 0;
    for (const e of expenses) {
      if (e.paidByUserId === me._id) {
        const split = e.splits.find((s) => s.userId === userId && !s.paid);
        if (split) balance += split.amount;
      } else {
        const split = e.splits.find((s) => s.userId === me._id && !s.paid);
        if (split) balance -= split.amount;
      }
    }
    for (const s of settlements) {
      if (s.paidByUserId === me._id) balance += s.amount;
      else balance -= s.amount;
    }

    // Return expenses, settlements, other user info, and balance
    const other = await ctx.db.get(userId);
    if (!other) throw new Error("User not found");
    return {
      expenses,
      settlements,
      otherUser: {
        id: other._id,
        name: other.name,
        email: other.email,
        imageUrl: other.imageUrl,
      },
      balance,
    };
  },
});

// Delete an expense
export const deleteExpense = mutation({
  args: { expenseId: v.id("expenses") },
  handler: async (ctx, args) => {
    const user = await ctx.runQuery(internal.users.getCurrentUser);
    const expense = await ctx.db.get(args.expenseId);
    if (!expense) throw new Error("Expense not found");

    // Only creator or payer can delete
    if (expense.createdBy !== user._id && expense.paidByUserId !== user._id) {
      throw new Error("Not authorized to delete this expense");
    }

    // Remove or update related settlements
    const allSettlements = await ctx.db.query("settlements").collect();
    const related = allSettlements.filter(
      (s) => s.relatedExpenseIds && s.relatedExpenseIds.includes(args.expenseId)
    );

    for (const s of related) {
      const updatedIds = s.relatedExpenseIds.filter(
        (id) => id !== args.expenseId
      );
      if (updatedIds.length === 0) {
        await ctx.db.delete(s._id);
      } else {
        await ctx.db.patch(s._id, { relatedExpenseIds: updatedIds });
      }
    }

    // Delete expense
    await ctx.db.delete(args.expenseId);
    return { success: true };
  },
});
