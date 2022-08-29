import { Eip712Domain } from '../types';

import * as polygon from './polygon.json';

export const EIP_712_REGISTRY: Record<
    number,
    Record<string, { kind: string; domain: Eip712Domain; domainSeparator: string }>
> = {
    137: polygon,
};
