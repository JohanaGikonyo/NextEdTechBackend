import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { CoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';

@Module({ imports: [DatabaseModule], controllers: [CoursesController], providers: [CoursesService] })
export class CoursesModule {}
