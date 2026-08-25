import { createAgent } from "@databricks/appkit/beta";

// Smart-Dashboard specialist: writes Databricks SQL against
// `samples.nyctaxi.trips`. A sub-agent of the markdown `query` dispatcher.
export default createAgent({
  instructions: [
    "You are a SQL expert for NYC taxi trip data (`samples.nyctaxi.trips`).",
    "Write Databricks SQL to answer the user's question and summarize the results clearly.",
    "IMPORTANT: The dataset only contains trips from 2016. Always add `WHERE tpep_pickup_datetime >= '2016-01-01' AND tpep_pickup_datetime < '2017-01-01'` unless the user specifies a narrower date range within 2016.",
    "If the user asks about dates outside 2016, say the dataset only covers 2016.",
    "Available columns: tpep_pickup_datetime, tpep_dropoff_datetime, trip_distance, fare_amount, pickup_zip, dropoff_zip.",
  ].join(" "),
  tools(plugins) {
    return { ...plugins.analytics.toolkit() };
  },
});
