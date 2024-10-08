CREATE TABLE `coreOwnership_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `coreOwnership` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`authCoreId` text NOT NULL,
	`configCoreId` text NOT NULL,
	`dataCoreId` text NOT NULL,
	`blobCoreId` text NOT NULL,
	`blobIndexCoreId` text NOT NULL,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cores` (
	`publicKey` blob NOT NULL,
	`namespace` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deviceInfo_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deviceInfo` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`name` text NOT NULL,
	`deviceType` text NOT NULL,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `field_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `field` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`tagKey` text NOT NULL,
	`type` text NOT NULL,
	`label` text NOT NULL,
	`appearance` text,
	`snakeCase` integer,
	`options` text,
	`universal` integer,
	`placeholder` text,
	`helperText` text,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `icon_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `icon` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`name` text NOT NULL,
	`variants` text NOT NULL,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `observation` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`lat` real,
	`lon` real,
	`attachments` text NOT NULL,
	`tags` text NOT NULL,
	`metadata` text,
	`presetRef` text,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preset_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `preset` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`name` text NOT NULL,
	`geometry` text NOT NULL,
	`tags` text NOT NULL,
	`addTags` text NOT NULL,
	`removeTags` text NOT NULL,
	`fieldRefs` text NOT NULL,
	`iconRef` text,
	`terms` text NOT NULL,
	`color` text,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`roleId` text NOT NULL,
	`fromIndex` integer NOT NULL,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `track_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `track` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`locations` text NOT NULL,
	`observationRefs` text NOT NULL,
	`tags` text NOT NULL,
	`forks` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `translation_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `translation` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`docRef` text NOT NULL,
	`docRefType` text NOT NULL,
	`propertyRef` text NOT NULL,
	`languageCode` text NOT NULL,
	`regionCode` text,
	`message` text NOT NULL,
	`forks` text NOT NULL
);
