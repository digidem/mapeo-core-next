CREATE TABLE `remoteDetectionAlert_backlink` (
	`versionId` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `remoteDetectionAlert` (
	`docId` text PRIMARY KEY NOT NULL,
	`versionId` text NOT NULL,
	`originalVersionId` text NOT NULL,
	`schemaName` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`links` text NOT NULL,
	`deleted` integer NOT NULL,
	`detectionDateStart` text NOT NULL,
	`detectionDateEnd` text NOT NULL,
	`sourceId` text NOT NULL,
	`metadata` text NOT NULL,
	`geometry` text NOT NULL,
	`forks` text NOT NULL
);
