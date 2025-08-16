import { useUser } from "@clerk/nextjs";
import { useConvexAuth } from "convex/react";
import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Hook to ensure the authenticated Clerk user is also stored
 * in the Convex `users` table, and track authentication status.
 */
export function useStoreUser() {
  const { isLoading, isAuthenticated } = useConvexAuth(); // Convex auth state
  const { user } = useUser(); // Clerk user info

  const [userId, setUserId] = useState(null); // Tracks stored Convex user ID
  const storeUser = useMutation(api.users.store); // Convex mutation to store user

  useEffect(() => {
    // Skip if no authenticated user
    if (!isAuthenticated) return;

    // Store authenticated user in Convex DB
    async function createUser() {
      const id = await storeUser();
      setUserId(id);
    }

    createUser();

    // Reset state on unmount or identity change
    return () => setUserId(null);
  }, [isAuthenticated, storeUser, user?.id]);

  // Combine Convex + Clerk state for reliable auth check
  return {
    isLoading: isLoading || (isAuthenticated && userId === null),
    isAuthenticated: isAuthenticated && userId !== null,
  };
}
