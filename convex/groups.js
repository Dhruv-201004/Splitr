import { query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Get groups for current user (and optionally details of one group with members)
export const getGroupOrMembers = query({
  args: { groupId: v.optional(v.id("groups")) },
  handler: async (ctx, args) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

    // Groups where user is a member
    const allGroups = await ctx.db.query("groups").collect();
    const userGroups = allGroups.filter((g) =>
      g.members.some((m) => m.userId === currentUser._id)
    );

    if (args.groupId) {
      const selectedGroup = userGroups.find((g) => g._id === args.groupId);
      if (!selectedGroup) throw new Error("Group not found or not a member");

      // Fetch member details
      const memberDetails = await Promise.all(
        selectedGroup.members.map(async (m) => {
          const u = await ctx.db.get(m.userId);
          if (!u) return null;
          return {
            id: u._id,
            name: u.name,
            email: u.email,
            imageUrl: u.imageUrl,
            role: m.role,
          };
        })
      );

      return {
        selectedGroup: {
          id: selectedGroup._id,
          name: selectedGroup.name,
          description: selectedGroup.description,
          createdBy: selectedGroup.createdBy,
          members: memberDetails.filter(Boolean),
        },
        groups: userGroups.map((g) => ({
          id: g._id,
          name: g.name,
          description: g.description,
          memberCount: g.members.length,
        })),
      };
    }

    // Return groups only
    return {
      selectedGroup: null,
      groups: userGroups.map((g) => ({
        id: g._id,
        name: g.name,
        description: g.description,
        memberCount: g.members.length,
      })),
    };
  },
});

// Get all expenses, settlements, and balances for a group
export const getGroupExpenses = query({
  args: { groupId: v.id("groups") },
  handler: async (ctx, { groupId }) => {
    const currentUser = await ctx.runQuery(internal.users.getCurrentUser);

    const group = await ctx.db.get(groupId);
    if (!group) throw new Error("Group not found");
    if (!group.members.some((m) => m.userId === currentUser._id))
      throw new Error("Not a group member");

    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_group", (q) => q.eq("groupId", groupId))
      .collect();

    const settlements = await ctx.db
      .query("settlements")
      .filter((q) => q.eq(q.field("groupId"), groupId))
      .collect();

    // Member details
    const memberDetails = await Promise.all(
      group.members.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return { id: u._id, name: u.name, imageUrl: u.imageUrl, role: m.role };
      })
    );
    const ids = memberDetails.map((m) => m.id);

    // Initialize totals and ledger
    const totals = Object.fromEntries(ids.map((id) => [id, 0]));
    const ledger = {};
    ids.forEach((a) => {
      ledger[a] = {};
      ids.forEach((b) => {
        if (a !== b) ledger[a][b] = 0;
      });
    });

    // Apply expenses
    for (const exp of expenses) {
      const payer = exp.paidByUserId;
      for (const split of exp.splits) {
        if (split.userId === payer || split.paid) continue;
        totals[payer] += split.amount;
        totals[split.userId] -= split.amount;
        ledger[split.userId][payer] += split.amount;
      }
    }

    // Apply settlements
    for (const s of settlements) {
      totals[s.paidByUserId] += s.amount;
      totals[s.receivedByUserId] -= s.amount;
      ledger[s.paidByUserId][s.receivedByUserId] -= s.amount;
    }

    // Net pair-wise ledger
    ids.forEach((a) => {
      ids.forEach((b) => {
        if (a >= b) return;
        const diff = ledger[a][b] - ledger[b][a];
        if (diff > 0) {
          ledger[a][b] = diff;
          ledger[b][a] = 0;
        } else if (diff < 0) {
          ledger[b][a] = -diff;
          ledger[a][b] = 0;
        } else {
          ledger[a][b] = ledger[b][a] = 0;
        }
      });
    });

    // Compute balances
    const balances = memberDetails.map((m) => ({
      ...m,
      totalBalance: totals[m.id],
      owes: Object.entries(ledger[m.id])
        .filter(([, v]) => v > 0)
        .map(([to, amount]) => ({ to, amount })),
      owedBy: ids
        .filter((other) => ledger[other][m.id] > 0)
        .map((other) => ({ from: other, amount: ledger[other][m.id] })),
    }));

    const userLookupMap = {};
    memberDetails.forEach((m) => {
      userLookupMap[m.id] = m;
    });

    return {
      group: {
        id: group._id,
        name: group.name,
        description: group.description,
      },
      members: memberDetails,
      expenses,
      settlements,
      balances,
      userLookupMap,
    };
  },
});
