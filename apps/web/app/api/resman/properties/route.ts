import { createListRoute } from "@/lib/resman-api";
import { propertiesResource } from "@/lib/resman-resources";

export const GET = createListRoute(propertiesResource);
