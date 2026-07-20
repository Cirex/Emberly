import { createDetailRoute } from "@/lib/resman-api";
import { mlgwAccountsResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(mlgwAccountsResource);
