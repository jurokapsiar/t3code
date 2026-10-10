export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<K, keyof T>>
  : never;
