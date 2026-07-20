import { createListRoute } from "@/lib/resman-api";
import { mlgwAccountsResource } from "@/lib/resman-resources";

export const GET = createListRoute(mlgwAccountsResource);
