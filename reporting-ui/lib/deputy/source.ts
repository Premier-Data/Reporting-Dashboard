// Where a Deputy view gets its rows from. The default is the existing
// deputy-read function (the user's own company); the GameFace page injects its
// own source.
import {
  getDeputyRosters,
  getDeputyTimesheets,
  type DeputyRosterRow,
  type DeputyTimesheetRow,
} from "@/lib/api/deputy";

export interface DeputySource {
  getRosters(): Promise<DeputyRosterRow[]>;
  getTimesheets(opts?: { sync?: boolean }): Promise<DeputyTimesheetRow[]>;
}

export const defaultDeputySource: DeputySource = {
  getRosters: () => getDeputyRosters(),
  getTimesheets: (opts) => getDeputyTimesheets(opts),
};
