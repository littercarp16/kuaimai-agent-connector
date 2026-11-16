// Shared by native discovery and local task registration in one connector
// process. Capture before asynchronous validation; wall-clock ties are normal.
let order=0;
export const nextSourceOrder=()=>++order;
