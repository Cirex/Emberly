import { createListRoute } from "@/lib/resman-api";
import { floorplansResource } from "@/lib/resman-resources";

export const GET = createListRoute(floorplansResource);
