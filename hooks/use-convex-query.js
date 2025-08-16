import { useQuery, useMutation } from "convex/react";
import { useState, useEffect } from "react";
import { toast } from "sonner";

/**
 * Custom hook to wrap Convex queries with loading and error state management.
 */
export const useConvexQuery = (query, ...args) => {
  const result = useQuery(query, ...args); // Run Convex query

  const [data, setData] = useState(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Sync local state with query result
  useEffect(() => {
    if (result === undefined) {
      setIsLoading(true); // Query still loading
    } else {
      try {
        setData(result); // Update data on success
        setError(null);
      } catch (err) {
        setError(err); // Catch parsing/logic errors
        toast.error(err.message);
      } finally {
        setIsLoading(false);
      }
    }
  }, [result]);

  return {
    data,
    isLoading,
    error,
  };
};

/**
 * Custom hook to wrap Convex mutations with loading, error, and result state.
 */
export const useConvexMutation = (mutation) => {
  const mutationFn = useMutation(mutation); // Convex mutation function

  const [data, setData] = useState(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Wrapper to execute mutation with error + loading handling
  const mutate = async (...args) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await mutationFn(...args); // Run mutation
      setData(response);
      return response;
    } catch (err) {
      setError(err);
      toast.error(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return { mutate, data, isLoading, error };
};
