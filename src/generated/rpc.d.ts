/// <reference types="node" />
import _m0 from "protobufjs/minimal.js";
import { EncryptionKeys } from "./keys.js";
export interface Invite {
    inviteId: Buffer;
    projectPublicId: string;
    projectName: string;
    roleName?: string | undefined;
    roleDescription?: string | undefined;
    invitorName: string;
}
export interface InviteCancel {
    inviteId: Buffer;
}
export interface InviteResponse {
    inviteId: Buffer;
    decision: InviteResponse_Decision;
}
export declare const InviteResponse_Decision: {
    readonly REJECT: "REJECT";
    readonly ACCEPT: "ACCEPT";
    readonly ALREADY: "ALREADY";
    readonly UNRECOGNIZED: "UNRECOGNIZED";
};
export type InviteResponse_Decision = typeof InviteResponse_Decision[keyof typeof InviteResponse_Decision];
export declare function inviteResponse_DecisionFromJSON(object: any): InviteResponse_Decision;
export declare function inviteResponse_DecisionToNumber(object: InviteResponse_Decision): number;
export interface ProjectJoinDetails {
    inviteId: Buffer;
    projectKey: Buffer;
    encryptionKeys: EncryptionKeys | undefined;
}
export interface DeviceInfo {
    name: string;
    deviceType?: DeviceInfo_DeviceType | undefined;
}
export declare const DeviceInfo_DeviceType: {
    readonly mobile: "mobile";
    readonly tablet: "tablet";
    readonly desktop: "desktop";
    readonly UNRECOGNIZED: "UNRECOGNIZED";
};
export type DeviceInfo_DeviceType = typeof DeviceInfo_DeviceType[keyof typeof DeviceInfo_DeviceType];
export declare function deviceInfo_DeviceTypeFromJSON(object: any): DeviceInfo_DeviceType;
export declare function deviceInfo_DeviceTypeToNumber(object: DeviceInfo_DeviceType): number;
export declare const Invite: {
    encode(message: Invite, writer?: _m0.Writer): _m0.Writer;
    decode(input: _m0.Reader | Uint8Array, length?: number): Invite;
    create<I extends {
        inviteId?: Buffer;
        projectPublicId?: string;
        projectName?: string;
        roleName?: string | undefined;
        roleDescription?: string | undefined;
        invitorName?: string;
    } & {
        inviteId?: Buffer;
        projectPublicId?: string;
        projectName?: string;
        roleName?: string | undefined;
        roleDescription?: string | undefined;
        invitorName?: string;
    } & { [K in Exclude<keyof I, keyof Invite>]: never; }>(base?: I): Invite;
    fromPartial<I_1 extends {
        inviteId?: Buffer;
        projectPublicId?: string;
        projectName?: string;
        roleName?: string | undefined;
        roleDescription?: string | undefined;
        invitorName?: string;
    } & {
        inviteId?: Buffer;
        projectPublicId?: string;
        projectName?: string;
        roleName?: string | undefined;
        roleDescription?: string | undefined;
        invitorName?: string;
    } & { [K_1 in Exclude<keyof I_1, keyof Invite>]: never; }>(object: I_1): Invite;
};
export declare const InviteCancel: {
    encode(message: InviteCancel, writer?: _m0.Writer): _m0.Writer;
    decode(input: _m0.Reader | Uint8Array, length?: number): InviteCancel;
    create<I extends {
        inviteId?: Buffer;
    } & {
        inviteId?: Buffer;
    } & { [K in Exclude<keyof I, "inviteId">]: never; }>(base?: I): InviteCancel;
    fromPartial<I_1 extends {
        inviteId?: Buffer;
    } & {
        inviteId?: Buffer;
    } & { [K_1 in Exclude<keyof I_1, "inviteId">]: never; }>(object: I_1): InviteCancel;
};
export declare const InviteResponse: {
    encode(message: InviteResponse, writer?: _m0.Writer): _m0.Writer;
    decode(input: _m0.Reader | Uint8Array, length?: number): InviteResponse;
    create<I extends {
        inviteId?: Buffer;
        decision?: InviteResponse_Decision;
    } & {
        inviteId?: Buffer;
        decision?: InviteResponse_Decision;
    } & { [K in Exclude<keyof I, keyof InviteResponse>]: never; }>(base?: I): InviteResponse;
    fromPartial<I_1 extends {
        inviteId?: Buffer;
        decision?: InviteResponse_Decision;
    } & {
        inviteId?: Buffer;
        decision?: InviteResponse_Decision;
    } & { [K_1 in Exclude<keyof I_1, keyof InviteResponse>]: never; }>(object: I_1): InviteResponse;
};
export declare const ProjectJoinDetails: {
    encode(message: ProjectJoinDetails, writer?: _m0.Writer): _m0.Writer;
    decode(input: _m0.Reader | Uint8Array, length?: number): ProjectJoinDetails;
    create<I extends {
        inviteId?: Buffer;
        projectKey?: Buffer;
        encryptionKeys?: {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        };
    } & {
        inviteId?: Buffer;
        projectKey?: Buffer;
        encryptionKeys?: {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        } & {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        } & { [K in Exclude<keyof I["encryptionKeys"], keyof EncryptionKeys>]: never; };
    } & { [K_1 in Exclude<keyof I, keyof ProjectJoinDetails>]: never; }>(base?: I): ProjectJoinDetails;
    fromPartial<I_1 extends {
        inviteId?: Buffer;
        projectKey?: Buffer;
        encryptionKeys?: {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        };
    } & {
        inviteId?: Buffer;
        projectKey?: Buffer;
        encryptionKeys?: {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        } & {
            auth?: Buffer;
            data?: Buffer;
            config?: Buffer;
            blobIndex?: Buffer;
            blob?: Buffer;
        } & { [K_2 in Exclude<keyof I_1["encryptionKeys"], keyof EncryptionKeys>]: never; };
    } & { [K_3 in Exclude<keyof I_1, keyof ProjectJoinDetails>]: never; }>(object: I_1): ProjectJoinDetails;
};
export declare const DeviceInfo: {
    encode(message: DeviceInfo, writer?: _m0.Writer): _m0.Writer;
    decode(input: _m0.Reader | Uint8Array, length?: number): DeviceInfo;
    create<I extends {
        name?: string;
        deviceType?: DeviceInfo_DeviceType | undefined;
    } & {
        name?: string;
        deviceType?: DeviceInfo_DeviceType | undefined;
    } & { [K in Exclude<keyof I, keyof DeviceInfo>]: never; }>(base?: I): DeviceInfo;
    fromPartial<I_1 extends {
        name?: string;
        deviceType?: DeviceInfo_DeviceType | undefined;
    } & {
        name?: string;
        deviceType?: DeviceInfo_DeviceType | undefined;
    } & { [K_1 in Exclude<keyof I_1, keyof DeviceInfo>]: never; }>(object: I_1): DeviceInfo;
};
