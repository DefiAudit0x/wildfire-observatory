import swaggerJsdoc from "swagger-jsdoc";
import config from "./config.js";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.3",
    info: {
      title: "North African Wildfire Observatory API",
      version: "1.0.0",
      description: "API for the North African Observatory for Forest Fires and Disasters. Monitors wildfires across Algeria, Tunisia, Morocco, and Libya.",
      contact: { name: "Nova DZ" },
    },
    servers: [
      { url: config.appUrl, description: config.nodeEnv === "production" ? "Production" : "Development" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  },
  apis: ["./server/routes/*.ts"],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
