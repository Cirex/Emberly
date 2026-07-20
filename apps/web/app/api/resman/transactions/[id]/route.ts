import { createDetailRoute } from "@/lib/resman-api";
import { transactionsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(transactionsResource);
