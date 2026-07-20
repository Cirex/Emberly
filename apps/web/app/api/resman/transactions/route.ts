import { createListRoute } from "@/lib/resman-api";
import { transactionsResource } from "@/lib/resman-resources";

export const GET = createListRoute(transactionsResource);
