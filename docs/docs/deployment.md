---
sidebar_position: 4
---

# Deployment

TODO:
- describe how to deploy an app built with App Kit
- Point to https://docs.databricks.com/aws/en/dev-tools/cli/install for installation instructions as a prerequisite
- General docs are here: https://docs.databricks.com/aws/en/dev-tools/cli/


Commands:

- databricks sync --watch . /Workspace/Users/pawel.kosiec@databricks.com/databricks_apps/pkosiec-failed-app -> to sync the code
- databricks apps deploy pkosiec-failed-app --source-code-path /Workspace/Users/pawel.kosiec@databricks.com/databricks_apps/pkosiec-failed-app
