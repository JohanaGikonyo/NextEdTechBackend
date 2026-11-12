import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CoursesService } from './courses.service.js';

@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}
  @Get() findAll() { return this.courses.findAll(); }
  @Get(':id') findOne(@Param('id') id: string) { return this.courses.findOne(id); }
  @Post() create(@Body() body: { title: string; description?: string }) { return this.courses.create(body); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: { title?: string; description?: string; status?: string }) { return this.courses.update(id, body); }
  @Delete(':id') remove(@Param('id') id: string) { return this.courses.remove(id); }
  @Post(':id/modules') addModule(@Param('id') id: string, @Body() body: { title: string; position?: number }) { return this.courses.addModule(id, body); }
  @Post('modules/:id/lessons') addLesson(@Param('id') id: string, @Body() body: { title: string; mediaId?: string; position?: number }) { return this.courses.addLesson(id, body); }
  @Post('lessons/:id/questions') addQuestions(@Param('id') id: string, @Body() body: { questions: Array<{ prompt: string; options: string[]; answerIndex: number }> }) { return this.courses.addQuestions(id, body.questions); }
  @Post('modules/:id/resources') addResource(@Param('id') id: string, @Body() body: { name: string; url?: string }) { return this.courses.addResource(id, body); }
}
