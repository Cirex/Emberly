import { createDetailRoute } from "@/lib/resman-api";
import { propertiesResource } from "@/lib/resman-resources";

export const GET = createDetailRoute(propertiesResource);
